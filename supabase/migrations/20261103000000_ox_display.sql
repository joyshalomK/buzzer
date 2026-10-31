-- =====================================================================
-- OX SURVIVAL — big-screen stage with walking characters
-- =====================================================================
-- The /display screen now shows every player as a small character that
-- walks to the O or X side the moment the player answers. Picks are
-- therefore public while answering (the answer key still is not).
--
--   * ox_public_state gains 'stage': one entry per character on the stage
--     (lobby: the candidates; in a game: the survivors plus the players
--     eliminated in the round on screen, so they can walk off). Characters
--     are keyed by avatar_key, a hash of the participant id: stable across
--     reloads, but the participant id itself is not exposed.
--     'correct' is the server's verdict and appears only after the reveal.
--   * ox_stage_moves: one row per accepted answer (avatar, pick). It is
--     published to Realtime so the display can move a character at once
--     instead of waiting for its next poll. Phones do not subscribe to it.
--     It holds nothing the display does not show anyway.
-- =====================================================================

create table public.ox_stage_moves (
  id         bigint generated always as identity primary key,
  -- no FK on room_id: its key-share lock on the room row would let an answer
  -- (holding the round) and the host's close (holding the room, waiting for
  -- the round) deadlock. Rows go away with their round.
  room_id    uuid not null,
  round_id   uuid not null references public.ox_rounds (id) on delete cascade,
  avatar_key text not null,
  pick       text not null check (pick in ('O', 'X')),
  created_at timestamptz not null default now()
);
create index ox_stage_moves_round_idx on public.ox_stage_moves (round_id);

alter table public.ox_stage_moves enable row level security;
revoke all on public.ox_stage_moves from anon, authenticated;
-- public on purpose: the projector shows the same thing
grant select on public.ox_stage_moves to anon, authenticated;
create policy ox_stage_moves_public_read on public.ox_stage_moves
  for select to anon, authenticated using (true);

create or replace function private.ox_avatar_key(p_participant_id uuid)
returns text language sql immutable set search_path = '' as $$
  select left(md5('ox-avatar:' || p_participant_id::text), 12)
$$;

-- Same as before, plus one ox_stage_moves row per stored answer.
create or replace function public.ox_answer(p_token text, p_round_id uuid, p_answer text, p_seq bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_received timestamptz := clock_timestamp();
  v_p public.participants;
  v_r public.ox_rounds;
  v_g public.ox_games;
  v_pl public.ox_players;
  v_ans text := upper(btrim(coalesce(p_answer, '')));
  v_seq bigint := coalesce(p_seq, 0);
  v_stored public.ox_answers;
begin
  v_p := private.ox_participant(p_token);
  if v_p.id is null then return jsonb_build_object('ok', false, 'result', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;
  if v_ans not in ('O', 'X') then return jsonb_build_object('ok', false, 'result', 'INVALID_ANSWER'); end if;

  -- SHARE: answers run in parallel; closing / revealing (FOR UPDATE) wait for them
  select * into v_r from public.ox_rounds where id = p_round_id for share;
  if not found then return jsonb_build_object('ok', false, 'result', 'STALE_ROUND'); end if;
  select * into v_g from public.ox_games where id = v_r.game_id;
  if v_g.room_id <> v_p.room_id or v_g.id <> (private.ox_current_game(v_p.room_id)).id
     or v_g.current_round_id is distinct from v_r.id then
    return jsonb_build_object('ok', false, 'result', 'STALE_ROUND');
  end if;
  -- the roster is fixed at the start; statuses only change at REVEAL (after closing)
  select * into v_pl from public.ox_players where game_id = v_g.id and participant_id = v_p.id;
  if not found then return jsonb_build_object('ok', false, 'result', 'NOT_PLAYING', 'round_id', v_r.id); end if;
  if v_pl.survival_status <> 'ALIVE' then
    return jsonb_build_object('ok', false, 'result', 'ELIMINATED', 'round_id', v_r.id);
  end if;
  if v_r.status = 'READY' then
    return jsonb_build_object('ok', false, 'result', 'NOT_OPEN', 'round_id', v_r.id);
  end if;
  select * into v_stored from public.ox_answers where round_id = v_r.id and participant_id = v_p.id;
  if v_r.status <> 'ANSWERING' then
    return jsonb_build_object('ok', false, 'result', 'CLOSED', 'round_id', v_r.id, 'answer', v_stored.selected_answer);
  end if;
  if v_received > v_r.deadline_at then
    return jsonb_build_object('ok', false, 'result', 'TOO_LATE', 'round_id', v_r.id, 'answer', v_stored.selected_answer);
  end if;

  insert into public.ox_answers as a (game_id, round_id, participant_id, selected_answer, client_seq, submitted_at)
  values (v_g.id, v_r.id, v_p.id, v_ans, v_seq, v_received)
  on conflict (round_id, participant_id) do update
     set selected_answer = excluded.selected_answer,
         client_seq = excluded.client_seq,
         submitted_at = excluded.submitted_at,
         change_count = a.change_count + (a.selected_answer <> excluded.selected_answer)::int
   where excluded.client_seq > a.client_seq
  returning * into v_stored;

  if not found then
    -- same or newer request already stored (retry, or requests overtook each other)
    select * into v_stored from public.ox_answers where round_id = v_r.id and participant_id = v_p.id;
    update public.participants set last_seen_at = now() where id = v_p.id;
    return jsonb_build_object('ok', true,
                              'result', case when v_stored.client_seq = v_seq then 'ACCEPTED' else 'STALE' end,
                              'round_id', v_r.id, 'answer', v_stored.selected_answer);
  end if;
  insert into public.ox_stage_moves (room_id, round_id, avatar_key, pick)
  values (v_g.room_id, v_r.id, private.ox_avatar_key(v_p.id), v_stored.selected_answer);
  update public.participants set last_seen_at = now() where id = v_p.id;
  return jsonb_build_object('ok', true, 'result', 'ACCEPTED', 'round_id', v_r.id, 'answer', v_stored.selected_answer);
end $$;

-- /display: as before, plus the characters on the stage.
create or replace function public.ox_public_state(p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_g public.ox_games;
  v_r public.ox_rounds;
begin
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform private.ox_settle(v_room.id);
  v_g := private.ox_current_game(v_room.id);
  v_r := private.ox_current_round(v_g);

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'game', private.ox_game_json(v_g),
    'round', private.ox_round_json(v_r, false),
    'counts', private.ox_counts(v_g, v_r, false),
    -- who is still in (short lists only: the screen has room for a few names)
    'survivors', case when v_g.status <> 'LOBBY' and private.ox_alive(v_g.id) <= 12
                      then private.ox_names(v_g.id, 'ALIVE', 12) else '[]'::jsonb end,
    'lobby', case when v_g.status = 'LOBBY' then coalesce(
               (select jsonb_agg(private.ox_player_name(c.id) order by c.joined_at)
                from (select * from private.ox_candidates(v_room.id) where not is_test limit 60) c), '[]'::jsonb)
             else '[]'::jsonb end,
    'winners', case when v_g.status = 'FINISHED' then private.ox_names(v_g.id, 'ALIVE', 30) else '[]'::jsonb end,
    'stage', case when v_g.status = 'LOBBY' then coalesce((
               select jsonb_agg(jsonb_build_object(
                        'key', private.ox_avatar_key(c.id), 'name', private.ox_player_name(c.id),
                        'alive', true, 'pick', null, 'correct', null) order by c.joined_at)
               from (select * from private.ox_candidates(v_room.id) order by joined_at limit 150) c), '[]'::jsonb)
             else coalesce((
               select jsonb_agg(jsonb_build_object(
                        'key', private.ox_avatar_key(p.participant_id), 'name', p.name,
                        'alive', p.survival_status = 'ALIVE',
                        'pick', case when v_r.status <> 'READY' then a.selected_answer end,
                        'correct', case when v_r.revealed_at is not null then x.correct end)
                        order by p.name)
               from public.ox_players p
               left join public.ox_answers a on a.round_id = v_r.id and a.participant_id = p.participant_id
               left join public.ox_round_results x on x.round_id = v_r.id and x.participant_id = p.participant_id
               where p.game_id = v_g.id
                 and (p.survival_status = 'ALIVE'
                      or (p.eliminated_round_id = v_r.id and v_g.status <> 'FINISHED'))), '[]'::jsonb) end,
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;

alter publication supabase_realtime add table public.ox_stage_moves;

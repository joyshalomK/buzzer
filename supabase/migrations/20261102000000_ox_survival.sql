-- =====================================================================
-- OX SURVIVAL MODE — 실시간 OX 서바이벌 (구두 출제)
-- =====================================================================
-- The host reads each question aloud. The system stores no questions: only
-- rounds, the host's secret O/X answer per round, the players' answers and
-- who is still alive. Wrong or missing answer = eliminated; the last one
-- standing is the champion.
--
-- Reuse
--   * Players are existing room participants of any kind: quiz-buzzer
--     nicknames and FAMILY SYNC/MATCH members (shown as "가족명 호칭") each
--     play as one individual, with the token they already have.
--
-- Game flow (all transitions are admin-only, admin_ox_action)
--   LOBBY -START-> ROUND_READY -OPEN-> ANSWERING -CLOSE/deadline-> ANSWER_CLOSED
--         -REVEAL-> RESULT_REVEALED | ROUND_VOID
--         -NEXT-> ROUND_READY (next round; after a void: the same round again)
--         -FINISH / CO_WIN / END-> FINISHED
--   * START freezes the roster: every active participant whose phone is
--     online (seen in the last 60 s) becomes an ALIVE player. Anyone joining
--     later — including someone re-joining under a new nickname — is not a
--     player and can only watch.
--   * The host must store the round's answer (admin_ox_set_answer) before
--     OPEN; it can be changed only while the round is READY.
--   * OPEN starts the answer window on the server clock:
--     deadline_at = started_at + duration_seconds. Answers are accepted only
--     while the round is ANSWERING and the server receive time <= deadline_at.
--   * REVEAL grades every player alive at that moment, in one transaction:
--     verdict rows are frozen into ox_round_results (primary key
--     round+participant, so a repeated REVEAL cannot grade twice) and wrong
--     or missing answers are ELIMINATED. Nobody's status changes before it.
--     If nobody answered correctly the round becomes VOID: verdicts are kept
--     as a record but no one is eliminated, and NEXT replays the round.
--   * Exactly one survivor => result CHAMPION is decided at REVEAL (no
--     further rounds); FINISH announces it. CO_WIN ends with every survivor
--     as joint winner. END stops the game where it is.
--   * NEW_GAME starts a separate game (game_number + 1); older games keep
--     their own rounds, answers and results.
--
-- Integrity / privacy
--   * Clients send only their secret token, the round id, O/X and a client
--     sequence number. The player comes from the token.
--   * One answer per player per round: UNIQUE (round_id, participant_id).
--     Changing the answer updates that row; a request with an older sequence
--     number cannot overwrite a newer one.
--   * Answers take a SHARE lock on the round row; closing / revealing take an
--     exclusive lock. A close therefore waits for in-flight answers and every
--     answer after it sees the round closed.
--   * The answer key lives only in ox_rounds, which clients cannot read and
--     which is not published to Realtime. Only ox_games (state, no answers)
--     is published. Public RPCs include the answer only after the reveal.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------

alter table public.rooms drop constraint rooms_mode_check;
alter table public.rooms add constraint rooms_mode_check check (mode in ('BUZZER', 'SYNC', 'MATCH', 'OX'));

create table public.ox_games (
  id                        uuid primary key default gen_random_uuid(),
  room_id                   uuid not null references public.rooms (id) on delete cascade,
  game_number               integer not null check (game_number > 0),
  status                    text not null default 'LOBBY'
                            check (status in ('LOBBY', 'ROUND_READY', 'ANSWERING', 'ANSWER_CLOSED',
                                              'RESULT_REVEALED', 'ROUND_VOID', 'FINISHED')),
  -- round on screen (0 in the lobby). A replayed void round keeps its number.
  current_round             integer not null default 0 check (current_round >= 0),
  -- the ox_rounds row on screen (no FK: rounds reference games)
  current_round_id          uuid,
  -- answer window of the next round to open
  time_limit_seconds        integer not null default 10 check (time_limit_seconds between 5 and 30),
  initial_participant_count integer check (initial_participant_count >= 0),
  -- CHAMPION: one survivor (decided at reveal) | CO_WINNERS: host declared
  -- joint winners | ENDED: host stopped the game
  result                    text check (result in ('CHAMPION', 'CO_WINNERS', 'ENDED')),
  -- bumped on every change so Realtime always delivers an event
  rev                       integer not null default 0,
  created_at                timestamptz not null default now(),
  started_at                timestamptz,
  finished_at               timestamptz,
  unique (room_id, game_number)
);

create table public.ox_rounds (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references public.ox_games (id) on delete cascade,
  -- 1, 2, 3 … for every round played in this game, replays included
  seq              integer not null check (seq > 0),
  round_number     integer not null check (round_number > 0),
  -- the host's secret answer; null until stored
  correct_answer   text check (correct_answer in ('O', 'X')),
  duration_seconds integer check (duration_seconds between 5 and 30),
  status           text not null default 'READY'
                   check (status in ('READY', 'ANSWERING', 'CLOSED', 'REVEALED', 'VOID')),
  started_at       timestamptz,
  deadline_at      timestamptz,
  closed_at        timestamptz,
  revealed_at      timestamptz,
  survivors_before integer,
  survivors_after  integer,
  correct_count    integer,
  o_count          integer,
  x_count          integer,
  created_at       timestamptz not null default now(),
  unique (game_id, seq),
  check (status = 'READY' or correct_answer is not null or (status = 'VOID' and started_at is null))
);

create table public.ox_players (
  game_id             uuid not null references public.ox_games (id) on delete cascade,
  participant_id      uuid not null references public.participants (id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 24),
  survival_status     text not null default 'ALIVE' check (survival_status in ('ALIVE', 'ELIMINATED')),
  eliminated_round    integer,
  -- the round that eliminated the player (no FK: both go with the game)
  eliminated_round_id uuid,
  joined_at           timestamptz not null default now(),
  primary key (game_id, participant_id),
  check ((survival_status = 'ALIVE') = (eliminated_round is null))
);

create table public.ox_answers (
  id              bigint generated always as identity primary key,
  game_id         uuid not null references public.ox_games (id) on delete cascade,
  round_id        uuid not null references public.ox_rounds (id) on delete cascade,
  participant_id  uuid not null references public.participants (id) on delete cascade,
  selected_answer text not null check (selected_answer in ('O', 'X')),
  -- client-side sequence of the request that set this value (newest wins)
  client_seq      bigint not null default 0,
  submitted_at    timestamptz not null,
  change_count    integer not null default 0,
  unique (round_id, participant_id)
);

-- Frozen verdicts, written at REVEAL for every player alive at that moment.
create table public.ox_round_results (
  round_id        uuid not null references public.ox_rounds (id) on delete cascade,
  game_id         uuid not null references public.ox_games (id) on delete cascade,
  participant_id  uuid not null references public.participants (id) on delete cascade,
  name            text not null,
  selected_answer text check (selected_answer in ('O', 'X')),
  correct         boolean not null,
  primary key (round_id, participant_id)
);
create index ox_round_results_game_idx on public.ox_round_results (game_id);

-- ---------------------------------------------------------------------
-- RLS & grants
-- ---------------------------------------------------------------------

alter table public.ox_games enable row level security;
alter table public.ox_rounds enable row level security;
alter table public.ox_players enable row level security;
alter table public.ox_answers enable row level security;
alter table public.ox_round_results enable row level security;

revoke all on public.ox_games, public.ox_rounds, public.ox_players, public.ox_answers, public.ox_round_results
  from anon, authenticated;

-- Game state only (no answer key, no answers): needed by Realtime postgres_changes.
grant select on public.ox_games to anon, authenticated;
create policy ox_games_public_read on public.ox_games
  for select to anon, authenticated using (true);
-- rounds / players / answers / results: no grants, no policies => RPC only.

-- ---------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------

create or replace function private.ox_game_json(g public.ox_games)
returns jsonb language sql stable set search_path = '' as $$
  select case when g.id is null then null else jsonb_build_object(
    'id', g.id, 'room_id', g.room_id, 'game_number', g.game_number, 'status', g.status,
    'current_round', g.current_round, 'current_round_id', g.current_round_id,
    'time_limit_seconds', g.time_limit_seconds, 'initial_participant_count', g.initial_participant_count,
    'result', g.result, 'rev', g.rev, 'created_at', g.created_at,
    'started_at', g.started_at, 'finished_at', g.finished_at) end
$$;

-- p_full (host): everything. Otherwise the answer key and the verdict
-- numbers appear only once the round was revealed.
create or replace function private.ox_round_json(r public.ox_rounds, p_full boolean)
returns jsonb language sql stable set search_path = '' as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'seq', r.seq, 'round_number', r.round_number, 'status', r.status,
    'duration_seconds', r.duration_seconds,
    'answer_set', r.correct_answer is not null,
    'correct_answer', case when p_full or r.revealed_at is not null then r.correct_answer end,
    'started_ms', private.epoch_ms(r.started_at),
    'deadline_ms', private.epoch_ms(r.deadline_at),
    'closed_ms', private.epoch_ms(r.closed_at),
    'revealed_ms', private.epoch_ms(r.revealed_at),
    'survivors_before', r.survivors_before,
    'survivors_after', case when p_full or r.revealed_at is not null then r.survivors_after end,
    'correct_count', case when p_full or r.revealed_at is not null then r.correct_count end,
    'o_count', case when p_full or r.revealed_at is not null then r.o_count end,
    'x_count', case when p_full or r.revealed_at is not null then r.x_count end) end
$$;

create or replace function private.ox_current_game(p_room_id uuid)
returns public.ox_games language sql stable set search_path = '' as $$
  select * from public.ox_games where room_id = p_room_id order by game_number desc limit 1
$$;

create or replace function private.ox_current_round(g public.ox_games)
returns public.ox_rounds language sql stable set search_path = '' as $$
  select * from public.ox_rounds where id = g.current_round_id and game_id = g.id
$$;

create or replace function private.ox_new_game(p_room_id uuid, p_time_limit integer)
returns public.ox_games language sql volatile set search_path = '' as $$
  insert into public.ox_games (room_id, game_number, time_limit_seconds)
  values (p_room_id,
          coalesce((select max(game_number) from public.ox_games where room_id = p_room_id), 0) + 1,
          coalesce(p_time_limit, 10))
  returning *
$$;

-- Drop every game of the room and start game 1 again (time limit is kept).
create or replace function private.ox_reset(p_room_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare v_limit integer;
begin
  select time_limit_seconds into v_limit from public.ox_games
  where room_id = p_room_id order by game_number desc limit 1;
  if not found then return; end if;
  delete from public.ox_games where room_id = p_room_id;
  perform private.ox_new_game(p_room_id, v_limit);
end $$;

-- How a participant is called in this game.
create or replace function private.ox_player_name(p_participant_id uuid)
returns text language sql stable set search_path = '' as $$
  select left(coalesce(t.team_name || ' ' || m.member_label, p.nickname), 24)
  from public.participants p
  left join public.team_members m on m.participant_id = p.id
  left join public.teams t on t.id = m.team_id
  where p.id = p_participant_id
$$;

-- Any participant (quiz nickname or family member) by secret token.
create or replace function private.ox_participant(p_token text)
returns public.participants language sql stable set search_path = '' as $$
  select p.* from private.participant_tokens t
  join public.participants p on p.id = t.participant_id
  where t.token_hash = private.hash_token(p_token)
$$;

-- Participants START would turn into players right now.
create or replace function private.ox_candidates(p_room_id uuid)
returns setof public.participants language sql stable set search_path = '' as $$
  select * from public.participants
  where room_id = p_room_id and is_active and (is_test or last_seen_at > now() - interval '60 seconds')
$$;

create or replace function private.ox_alive(p_game_id uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.ox_players where game_id = p_game_id and survival_status = 'ALIVE'
$$;

-- Closes an ANSWERING round. The caller holds the round row lock. Idempotent.
create or replace function private.ox_close(p_round_id uuid, p_closed_at timestamptz)
returns void language plpgsql volatile set search_path = '' as $$
declare v_r public.ox_rounds;
begin
  update public.ox_rounds set status = 'CLOSED', closed_at = p_closed_at
   where id = p_round_id and status = 'ANSWERING'
  returning * into v_r;
  if not found then return; end if;
  update public.ox_games set status = 'ANSWER_CLOSED', rev = rev + 1
   where id = v_r.game_id and status = 'ANSWERING' and current_round_id = v_r.id;
end $$;

-- ANSWERING rounds past their deadline are closed. Called by every read, so
-- the time limit needs no cron job; ox_answer checks the deadline itself.
-- Lock order everywhere: round row, then game row.
create or replace function private.ox_settle(p_room_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare v_r public.ox_rounds;
begin
  for v_r in
    select r.* from public.ox_rounds r
    join public.ox_games g on g.id = r.game_id
    where g.room_id = p_room_id and r.status = 'ANSWERING' and clock_timestamp() > r.deadline_at
    for update of r
  loop
    perform private.ox_close(v_r.id, v_r.deadline_at);
  end loop;
end $$;

-- New READY round (answer not stored yet). The caller holds the game lock.
create or replace function private.ox_prepare(g public.ox_games, p_round_number integer)
returns public.ox_games language plpgsql volatile set search_path = '' as $$
declare v_r public.ox_rounds;
begin
  insert into public.ox_rounds (game_id, seq, round_number, status, survivors_before)
  values (g.id, coalesce((select max(seq) from public.ox_rounds where game_id = g.id), 0) + 1,
          p_round_number, 'READY', private.ox_alive(g.id))
  returning * into v_r;
  update public.ox_games
     set status = 'ROUND_READY', current_round = p_round_number, current_round_id = v_r.id, rev = rev + 1
   where id = g.id returning * into g;
  return g;
end $$;

-- Live numbers. Answer distribution only for the host (p_full).
create or replace function private.ox_counts(g public.ox_games, r public.ox_rounds, p_full boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'initial', g.initial_participant_count,
    'alive', private.ox_alive(g.id),
    'eliminated', (select count(*) from public.ox_players where game_id = g.id and survival_status = 'ELIMINATED'),
    'answered', (select count(*) from public.ox_answers where round_id = r.id),
    'o', case when p_full then (select count(*) from public.ox_answers where round_id = r.id and selected_answer = 'O') end,
    'x', case when p_full then (select count(*) from public.ox_answers where round_id = r.id and selected_answer = 'X') end,
    'candidates', case when g.status = 'LOBBY' then (select count(*) from private.ox_candidates(g.room_id)) end)
$$;

-- Final ranking: survivors first, then later eliminations ahead of earlier
-- ones; same round = same rank (competition ranking 1, 1, 3).
create or replace function private.ox_ranking(g public.ox_games)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'participant_id', participant_id, 'name', name, 'status', survival_status,
           'eliminated_round', eliminated_round, 'rank', rnk) order by rnk, name), '[]'::jsonb)
  from (select p.*, rank() over (order by coalesce(p.eliminated_round, 2147483647) desc) as rnk
        from public.ox_players p where p.game_id = g.id) z
$$;

create or replace function private.ox_names(p_game_id uuid, p_status text, p_limit integer)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
  from (select name from public.ox_players where game_id = p_game_id and survival_status = p_status
        order by name limit p_limit) x
$$;

-- Verdicts of one revealed round (names of who stayed and who dropped out).
create or replace function private.ox_round_verdicts(p_round_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'participant_id', participant_id, 'name', name, 'selected', selected_answer, 'correct', correct)
           order by correct desc, name), '[]'::jsonb)
  from public.ox_round_results where round_id = p_round_id
$$;

-- ---------------------------------------------------------------------
-- Existing functions extended for OX
-- ---------------------------------------------------------------------

create or replace function public.admin_set_mode(p_admin_token text, p_room_id uuid, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_mode text := upper(btrim(coalesce(p_mode, '')));
begin
  perform private.require_admin(p_admin_token);
  v_room := private.lock_open_room(p_room_id);
  if v_mode not in ('BUZZER', 'SYNC', 'MATCH', 'OX') then raise exception 'INVALID_MODE'; end if;
  if v_mode = v_room.mode then return private.room_json(v_room); end if;
  perform private.sync_settle(p_room_id);
  perform private.match_settle(p_room_id);
  perform private.ox_settle(p_room_id);
  if exists (select 1 from public.rounds where room_id = p_room_id and status = 'ARMED')
     or exists (select 1 from public.sync_rounds where room_id = p_room_id and status = 'RUNNING')
     or exists (select 1 from public.family_match_games where room_id = p_room_id and status = 'QUESTION_OPEN')
     or exists (select 1 from public.ox_games where room_id = p_room_id and status = 'ANSWERING') then
    raise exception 'GAME_IN_PROGRESS';
  end if;
  if v_mode = 'SYNC' and not exists (select 1 from public.sync_rounds where room_id = p_room_id) then
    perform private.sync_new_round(p_room_id, 'WAITING', null);
  end if;
  if v_mode = 'MATCH' and not exists (select 1 from public.family_match_games where room_id = p_room_id) then
    perform private.match_new_game(p_room_id, null);
  end if;
  if v_mode = 'OX' and not exists (select 1 from public.ox_games where room_id = p_room_id) then
    perform private.ox_new_game(p_room_id, null);
  end if;
  update public.rooms set mode = v_mode, rev = rev + 1 where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

-- Whole-room reset also restarts OX SURVIVAL (players are deleted anyway).
create or replace function public.admin_reset_room(p_admin_token text, p_room_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  delete from public.rounds where room_id = p_room_id;
  delete from public.sync_rounds where room_id = p_room_id;
  perform private.match_reset(p_room_id);
  perform private.ox_reset(p_room_id);
  delete from public.participants where room_id = p_room_id;
  delete from public.teams where room_id = p_room_id;
  insert into public.rounds (room_id, round_number, status) values (p_room_id, 1, 'WAITING');
  perform private.sync_new_round(p_room_id, 'WAITING', null);
  update public.rooms
     set status = 'OPEN', announcement = null, announcement_at = null, rev = rev + 1
   where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

-- ---------------------------------------------------------------------
-- Participant RPCs
-- ---------------------------------------------------------------------

-- Heartbeat + state for any participant (also restores after reload).
-- role: CANDIDATE (lobby, will play if online at the start) | PLAYER |
-- SPECTATOR (not on the roster: joined after the start).
create or replace function public.ox_state(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_room public.rooms;
  v_g public.ox_games;
  v_r public.ox_rounds;
  v_pl public.ox_players;
  v_mine public.ox_answers;
  v_res public.ox_round_results;
  v_rank integer;
begin
  v_p := private.ox_participant(p_token);
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'error', 'KICKED'); end if;

  update public.participants set last_seen_at = now() where id = v_p.id;
  select * into v_room from public.rooms where id = v_p.room_id;
  perform private.ox_settle(v_room.id);
  v_g := private.ox_current_game(v_room.id);
  v_r := private.ox_current_round(v_g);
  select * into v_pl from public.ox_players where game_id = v_g.id and participant_id = v_p.id;
  select * into v_mine from public.ox_answers where round_id = v_r.id and participant_id = v_p.id;
  if v_r.revealed_at is not null then
    select * into v_res from public.ox_round_results where round_id = v_r.id and participant_id = v_p.id;
  end if;
  if v_g.status = 'FINISHED' and v_pl.participant_id is not null then
    select (e ->> 'rank')::int into v_rank
    from jsonb_array_elements(private.ox_ranking(v_g)) e where (e ->> 'participant_id')::uuid = v_p.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'me', jsonb_build_object(
      'participant_id', v_p.id,
      'name', coalesce(v_pl.name, private.ox_player_name(v_p.id)),
      'role', case when v_pl.participant_id is not null then 'PLAYER'
                   when v_g.status = 'LOBBY' then 'CANDIDATE' else 'SPECTATOR' end,
      'status', v_pl.survival_status,
      'eliminated_round', v_pl.eliminated_round,
      'answer', v_mine.selected_answer,
      'seq', v_mine.client_seq,
      'rank', v_rank),
    'verdict', case when v_res.round_id is not null then jsonb_build_object(
                 'selected', v_res.selected_answer, 'correct', v_res.correct) end,
    'room', private.room_json(v_room),
    'game', private.ox_game_json(v_g),
    'round', private.ox_round_json(v_r, false),
    'counts', private.ox_counts(v_g, v_r, false),
    'winners', case when v_g.status = 'FINISHED' then private.ox_names(v_g.id, 'ALIVE', 30) else '[]'::jsonb end,
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- THE ANSWER. Results:
--   ACCEPTED (answer = what is stored now) | STALE (an answer with a newer
--   p_seq is already stored; answer = that one) | NOT_OPEN | TOO_LATE |
--   CLOSED | STALE_ROUND | NOT_PLAYING | ELIMINATED | INVALID_ANSWER |
--   INVALID_TOKEN | KICKED
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
  update public.participants set last_seen_at = now() where id = v_p.id;
  return jsonb_build_object('ok', true, 'result', 'ACCEPTED', 'round_id', v_r.id, 'answer', v_stored.selected_answer);
end $$;

-- /display: round state, counts, the revealed result and the winners.
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
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- ---------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------

create or replace function public.admin_ox_state(p_admin_token text, p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_g public.ox_games;
  v_r public.ox_rounds;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform private.ox_settle(v_room.id);
  v_g := private.ox_current_game(v_room.id);
  v_r := private.ox_current_round(v_g);

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'game', private.ox_game_json(v_g),
    'round', private.ox_round_json(v_r, true),
    'counts', private.ox_counts(v_g, v_r, true),
    -- lobby: who START would put on the roster
    'candidates', case when v_g.status = 'LOBBY' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', p.id, 'name', private.ox_player_name(p.id), 'kind', p.kind, 'is_test', p.is_test,
               'online', p.is_test or p.last_seen_at > now() - interval '60 seconds') order by p.joined_at)
      from public.participants p where p.room_id = v_room.id and p.is_active), '[]'::jsonb)
      else '[]'::jsonb end,
    -- individual picks only once the round is closed (fairness while answering)
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', pl.participant_id, 'name', pl.name, 'status', pl.survival_status,
               'eliminated_round', pl.eliminated_round, 'is_test', p.is_test,
               'online', p.is_active and p.last_seen_at > now() - interval '20 seconds',
               'answered', a.id is not null,
               'selected', case when v_r.status in ('CLOSED', 'REVEALED', 'VOID') then a.selected_answer end)
               order by pl.survival_status, pl.name)
      from public.ox_players pl
      join public.participants p on p.id = pl.participant_id
      left join public.ox_answers a on a.round_id = v_r.id and a.participant_id = pl.participant_id
      where pl.game_id = v_g.id), '[]'::jsonb),
    'verdicts', case when v_r.revealed_at is not null then private.ox_round_verdicts(v_r.id) else '[]'::jsonb end,
    'rounds', coalesce((
      select jsonb_agg(private.ox_round_json(r, true) || jsonb_build_object(
               'eliminated_names', (select coalesce(jsonb_agg(x.name order by x.name), '[]'::jsonb)
                                    from public.ox_round_results x
                                    where x.round_id = r.id and not x.correct and r.status = 'REVEALED'))
             order by r.seq desc)
      from public.ox_rounds r where r.game_id = v_g.id), '[]'::jsonb),
    'ranking', private.ox_ranking(v_g),
    'games', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'game_number', x.game_number, 'status', x.status, 'current_round', x.current_round,
               'initial_participant_count', x.initial_participant_count, 'result', x.result,
               'finished_at', x.finished_at,
               'winners', case when x.status = 'FINISHED' then private.ox_names(x.id, 'ALIVE', 10) else '[]'::jsonb end)
             order by x.game_number desc)
      from public.ox_games x where x.room_id = v_room.id), '[]'::jsonb),
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- p_action: START | OPEN | CLOSE | REVEAL | NEXT | FINISH | CO_WIN | END | NEW_GAME
-- p_game_id / p_round_id must match what the host is looking at (null game
-- only when the room has no game yet; null round in the lobby), so a double
-- click or a stale screen cannot skip a round. CLOSE and REVEAL repeated on
-- the same round are no-ops.
create or replace function public.admin_ox_action(p_admin_token text, p_room_id uuid, p_game_id uuid,
                                                  p_round_id uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_g public.ox_games;
  v_r public.ox_rounds;
  v_n integer;
  v_correct integer;
  v_o integer;
  v_x integer;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  perform private.ox_settle(p_room_id);

  v_g := private.ox_current_game(p_room_id);
  if v_g.id is null then
    v_g := private.ox_new_game(p_room_id, null);
  elsif p_game_id is distinct from v_g.id or p_round_id is distinct from v_g.current_round_id then
    raise exception 'ROUND_CHANGED';
  end if;
  -- lock order: round, then game (same as ox_settle)
  select * into v_r from public.ox_rounds where id = v_g.current_round_id for update;
  select * into v_g from public.ox_games where id = v_g.id for update;

  case upper(coalesce(p_action, ''))
    when 'START' then
      if v_g.status <> 'LOBBY' then raise exception 'INVALID_TRANSITION'; end if;
      insert into public.ox_players (game_id, participant_id, name)
      select v_g.id, c.id, private.ox_player_name(c.id) from private.ox_candidates(p_room_id) c;
      get diagnostics v_n = row_count;
      if v_n < 2 then raise exception 'NOT_ENOUGH_PLAYERS'; end if;
      update public.ox_games set initial_participant_count = v_n, started_at = now()
       where id = v_g.id returning * into v_g;
      v_g := private.ox_prepare(v_g, 1);

    when 'OPEN' then
      if v_g.status = 'ANSWERING' then return private.ox_game_json(v_g); end if;
      if v_g.status <> 'ROUND_READY' then raise exception 'INVALID_TRANSITION'; end if;
      if v_r.correct_answer is null then raise exception 'ANSWER_REQUIRED'; end if;
      update public.ox_rounds
         set status = 'ANSWERING', duration_seconds = v_g.time_limit_seconds, started_at = clock_timestamp(),
             deadline_at = clock_timestamp() + v_g.time_limit_seconds * interval '1 second',
             survivors_before = private.ox_alive(v_g.id)
       where id = v_r.id;
      update public.ox_games set status = 'ANSWERING', rev = rev + 1 where id = v_g.id returning * into v_g;

    when 'CLOSE' then
      if v_g.status = 'ANSWERING' then
        perform private.ox_close(v_r.id, least(clock_timestamp(), v_r.deadline_at));
        select * into v_g from public.ox_games where id = v_g.id;
      elsif v_g.status <> 'ANSWER_CLOSED' then  -- already closed by the timer: nothing to do
        raise exception 'INVALID_TRANSITION';
      end if;

    when 'REVEAL' then
      if v_g.status in ('RESULT_REVEALED', 'ROUND_VOID') then return private.ox_game_json(v_g); end if;
      if v_g.status <> 'ANSWER_CLOSED' then raise exception 'INVALID_TRANSITION'; end if;
      -- grade everyone alive now; nobody's status changed since the round opened
      insert into public.ox_round_results (round_id, game_id, participant_id, name, selected_answer, correct)
      select v_r.id, v_g.id, p.participant_id, p.name, a.selected_answer,
             coalesce(a.selected_answer = v_r.correct_answer, false)
      from public.ox_players p
      left join public.ox_answers a on a.round_id = v_r.id and a.participant_id = p.participant_id
      where p.game_id = v_g.id and p.survival_status = 'ALIVE'
      on conflict (round_id, participant_id) do nothing;
      select count(*), count(*) filter (where correct),
             count(*) filter (where selected_answer = 'O'), count(*) filter (where selected_answer = 'X')
        into v_n, v_correct, v_o, v_x
      from public.ox_round_results where round_id = v_r.id;

      if v_correct = 0 then
        -- everybody would be out: the round does not count, all survivors stay in
        update public.ox_rounds
           set status = 'VOID', revealed_at = now(), survivors_before = v_n, survivors_after = v_n,
               correct_count = 0, o_count = v_o, x_count = v_x
         where id = v_r.id;
        update public.ox_games set status = 'ROUND_VOID', rev = rev + 1 where id = v_g.id returning * into v_g;
      else
        update public.ox_players p
           set survival_status = 'ELIMINATED', eliminated_round = v_r.round_number, eliminated_round_id = v_r.id
          from public.ox_round_results x
         where x.round_id = v_r.id and x.participant_id = p.participant_id and not x.correct
           and p.game_id = v_g.id and p.survival_status = 'ALIVE';
        update public.ox_rounds
           set status = 'REVEALED', revealed_at = now(), survivors_before = v_n, survivors_after = v_correct,
               correct_count = v_correct, o_count = v_o, x_count = v_x
         where id = v_r.id;
        update public.ox_games
           set status = 'RESULT_REVEALED', result = case when v_correct = 1 then 'CHAMPION' end, rev = rev + 1
         where id = v_g.id returning * into v_g;
      end if;

    when 'NEXT' then
      -- after a reveal: next round; after a void round: the same round again
      if v_g.status = 'RESULT_REVEALED' and v_g.result is null and private.ox_alive(v_g.id) >= 2 then
        v_g := private.ox_prepare(v_g, v_g.current_round + 1);
      elsif v_g.status = 'ROUND_VOID' and v_g.result is null then
        v_g := private.ox_prepare(v_g, v_g.current_round);
      else
        raise exception 'INVALID_TRANSITION';
      end if;

    when 'FINISH' then
      -- announce the champion decided at the reveal
      if v_g.status <> 'RESULT_REVEALED' or v_g.result is distinct from 'CHAMPION' then
        raise exception 'INVALID_TRANSITION';
      end if;
      update public.ox_games set status = 'FINISHED', finished_at = now(), rev = rev + 1
       where id = v_g.id returning * into v_g;

    when 'CO_WIN' then
      if v_g.status not in ('RESULT_REVEALED', 'ROUND_VOID') or v_g.result is not null
         or private.ox_alive(v_g.id) < 2 then
        raise exception 'INVALID_TRANSITION';
      end if;
      update public.ox_games set status = 'FINISHED', result = 'CO_WINNERS', finished_at = now(), rev = rev + 1
       where id = v_g.id returning * into v_g;

    when 'END' then
      if v_g.status in ('FINISHED', 'ANSWERING') then raise exception 'INVALID_TRANSITION'; end if;
      -- a round that was not graded does not count
      update public.ox_rounds set status = 'VOID' where id = v_r.id and status in ('READY', 'CLOSED');
      update public.ox_games set status = 'FINISHED', result = coalesce(result, 'ENDED'), finished_at = now(), rev = rev + 1
       where id = v_g.id returning * into v_g;

    when 'NEW_GAME' then
      if v_g.status = 'ANSWERING' then raise exception 'MATCH_OPEN'; end if;
      v_g := private.ox_new_game(p_room_id, v_g.time_limit_seconds);

    else
      raise exception 'INVALID_ACTION';
  end case;

  return private.ox_game_json(v_g);
end $$;

-- The host's secret answer of the READY round on screen. Changeable until OPEN.
create or replace function public.admin_ox_set_answer(p_admin_token text, p_room_id uuid, p_round_id uuid, p_answer text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_g public.ox_games;
  v_r public.ox_rounds;
  v_ans text := upper(btrim(coalesce(p_answer, '')));
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  if v_ans not in ('O', 'X') then raise exception 'INVALID_ANSWER'; end if;
  v_g := private.ox_current_game(p_room_id);
  if v_g.id is null or p_round_id is distinct from v_g.current_round_id then raise exception 'ROUND_CHANGED'; end if;
  select * into v_r from public.ox_rounds where id = p_round_id for update;
  if v_r.status <> 'READY' then raise exception 'ANSWER_LOCKED'; end if;
  update public.ox_rounds set correct_answer = v_ans where id = v_r.id returning * into v_r;
  -- rev only: the event says "something changed", never what the answer is
  update public.ox_games set rev = rev + 1 where id = v_g.id;
  return private.ox_round_json(v_r, true);
end $$;

-- Answer window for the rounds opened from now on.
create or replace function public.admin_ox_set_time_limit(p_admin_token text, p_room_id uuid, p_seconds integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_g public.ox_games;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  if p_seconds is null or p_seconds not between 5 and 30 then raise exception 'INVALID_DURATION'; end if;
  v_g := private.ox_current_game(p_room_id);
  if v_g.id is null then raise exception 'ROUND_CHANGED'; end if;
  update public.ox_games set time_limit_seconds = p_seconds, rev = rev + 1
   where id = v_g.id returning * into v_g;
  return private.ox_game_json(v_g);
end $$;

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function
  public.ox_state(text),
  public.ox_answer(text, uuid, text, bigint),
  public.ox_public_state(text),
  public.admin_ox_state(text, text),
  public.admin_ox_action(text, uuid, uuid, uuid, text),
  public.admin_ox_set_answer(text, uuid, uuid, text),
  public.admin_ox_set_time_limit(text, uuid, integer)
from public;
grant execute on function
  public.ox_state(text),
  public.ox_answer(text, uuid, text, bigint),
  public.ox_public_state(text),
  public.admin_ox_state(text, text),
  public.admin_ox_action(text, uuid, uuid, uuid, text),
  public.admin_ox_set_answer(text, uuid, uuid, text),
  public.admin_ox_set_time_limit(text, uuid, integer)
to anon, authenticated;

-- Realtime: game state changes (no answer key and no answers in this table)
alter publication supabase_realtime add table public.ox_games;

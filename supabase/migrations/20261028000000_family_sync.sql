-- =====================================================================
-- FAMILY SYNC MODE — "Family Sync Challenge"
-- =====================================================================
-- Teams of exactly two people press once within 10 seconds of a server-side
-- start instant; the team whose two presses arrived closest together wins.
--
-- Timing model
--   * START schedules the GO instant `lead_ms` (3 s) in the future using the
--     server clock, so every phone gets the start signal *before* it happens
--     and counts down to the same server instant (clients estimate their
--     offset to the server clock from RPC round trips).
--   * Every press is timestamped with clock_timestamp() when the RPC starts
--     executing in PostgreSQL. elapsed_ms = received_at - started_at, rounded
--     to whole milliseconds. timestamptz has microsecond precision, but the
--     value measures *arrival at the database*, which includes each phone's
--     network latency (typically 20-150 ms, jitter of tens of ms). It is not
--     the physical touch time. The ranking uses these rounded server values
--     only — what is shown is exactly what is ranked.
--   * The 10 s window is enforced on the server: a press is accepted only if
--     started_at <= received_at <= started_at + duration_ms.
--
-- Integrity
--   * Clients send only their secret token and the round id. The team and
--     participant are derived from the token on the server, so nobody can
--     press for another person or team.
--   * At most 2 members per team: UNIQUE (team_id, slot), slot in (1, 2).
--   * One press per participant per round: UNIQUE (sync_round_id, participant_id).
--   * At most 2 presses per team per round: UNIQUE (sync_round_id, team_id, slot).
--   * Presses of a round are serialised by locking the round row, so the
--     checks above and the "everyone pressed => close early" rule are exact.
--
-- Compatibility with the quiz buzzer
--   * participants.kind separates buzzer players from sync team members.
--     Buzzer RPCs ignore/reject SYNC participants and vice versa, and the
--     buzzer's unique-nickname rule only applies to buzzer players.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------

alter table public.rooms
  add column mode text not null default 'BUZZER' check (mode in ('BUZZER', 'SYNC')),
  -- whether /display shows "n of m pressed" while a sync round runs
  add column sync_show_progress boolean not null default false;

alter table public.participants
  add column kind text not null default 'BUZZER' check (kind in ('BUZZER', 'SYNC'));

drop index public.participants_room_nickname_uq;
create unique index participants_room_nickname_uq
  on public.participants (room_id, lower(nickname)) where is_active and kind = 'BUZZER';

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  team_name  text not null check (char_length(team_name) between 1 and 10),
  created_at timestamptz not null default now()
);
-- same family nickname (case/space-insensitive) => same team
create unique index teams_room_name_uq on public.teams (room_id, lower(team_name));

create table public.team_members (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid not null references public.teams (id) on delete cascade,
  participant_id uuid not null unique references public.participants (id) on delete cascade,
  member_label   text not null check (char_length(member_label) between 1 and 8),
  slot           smallint not null check (slot in (1, 2)),
  created_at     timestamptz not null default now(),
  -- DB-level guarantee: never a third member
  unique (team_id, slot)
);

create table public.sync_rounds (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  round_number  integer not null check (round_number > 0),
  status        text not null default 'WAITING'
                check (status in ('WAITING', 'READY', 'RUNNING', 'FINISHED', 'RESULTS')),
  -- the scheduled GO instant (server clock); set by START
  started_at    timestamptz,
  -- when input actually closed (deadline, early finish, or host stop)
  ended_at      timestamptz,
  duration_ms   integer not null default 10000 check (duration_ms between 1000 and 60000),
  lead_ms       integer not null default 3000 check (lead_ms between 0 and 10000),
  -- tie-break rematch: only these teams play. null = every team
  team_ids      uuid[],
  -- results reveal: teams with rank >= revealed_rank (and every rank > 5) are
  -- public. 1 = everything public. null = nothing public yet.
  revealed_rank integer check (revealed_rank >= 1),
  created_at    timestamptz not null default now(),
  unique (room_id, round_number)
);

create table public.sync_buzzes (
  id             bigint generated always as identity primary key,
  sync_round_id  uuid not null references public.sync_rounds (id) on delete cascade,
  team_id        uuid not null references public.teams (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  received_at    timestamptz not null,
  elapsed_ms     integer not null check (elapsed_ms >= 0),
  slot           smallint not null check (slot in (1, 2)),
  unique (sync_round_id, participant_id),
  unique (sync_round_id, team_id, slot)
);

-- Leaving / being kicked frees the team slot (buzz history is kept).
create or replace function private.on_participant_deactivated()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.team_members where participant_id = new.id;
  return new;
end $$;

create trigger participants_leave_team
  after update of is_active on public.participants
  for each row when (old.is_active and not new.is_active)
  execute function private.on_participant_deactivated();

-- ---------------------------------------------------------------------
-- RLS & grants
-- ---------------------------------------------------------------------

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.sync_rounds enable row level security;
alter table public.sync_buzzes enable row level security;

revoke all on public.teams, public.team_members, public.sync_rounds, public.sync_buzzes
  from anon, authenticated;

-- Round state only (no names, no times): needed by Realtime postgres_changes.
grant select on public.sync_rounds to anon, authenticated;
create policy sync_rounds_public_read on public.sync_rounds
  for select to anon, authenticated using (true);
-- teams / team_members / sync_buzzes: no grants, no policies => RPC only.

-- ---------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------

create or replace function private.room_json(r public.rooms)
returns jsonb language sql stable set search_path = '' as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'room_code', r.room_code, 'status', r.status,
    'announcement', r.announcement, 'announcement_at', r.announcement_at,
    'test_mode', r.test_mode, 'rev', r.rev, 'created_at', r.created_at,
    'mode', r.mode, 'sync_show_progress', r.sync_show_progress) end
$$;

create or replace function private.epoch_ms(t timestamptz)
returns bigint language sql immutable set search_path = '' as $$
  select round(extract(epoch from t) * 1000)::bigint
$$;

create or replace function private.clean_text(p_text text, p_max integer, p_code text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := btrim(regexp_replace(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g'));
  if char_length(v) < 1 then raise exception '%', p_code || '_REQUIRED'; end if;
  if char_length(v) > p_max then raise exception '%', p_code || '_TOO_LONG'; end if;
  return v;
end $$;

create or replace function private.sync_round_json(r public.sync_rounds)
returns jsonb language sql stable set search_path = '' as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'room_id', r.room_id, 'round_number', r.round_number, 'status', r.status,
    'started_at', r.started_at, 'ended_at', r.ended_at,
    'started_ms', private.epoch_ms(r.started_at),
    'deadline_ms', private.epoch_ms(r.started_at + r.duration_ms * interval '1 millisecond'),
    'duration_ms', r.duration_ms, 'lead_ms', r.lead_ms,
    'team_ids', to_jsonb(r.team_ids), 'revealed_rank', r.revealed_rank,
    'created_at', r.created_at) end
$$;

create or replace function private.sync_current_round(p_room_id uuid)
returns public.sync_rounds language sql stable set search_path = '' as $$
  select * from public.sync_rounds where room_id = p_room_id order by round_number desc limit 1
$$;

-- RUNNING rounds past their deadline become FINISHED. Called by every read,
-- so the 10 s auto-stop needs no cron job. Correctness never depends on it:
-- sync_buzz checks the deadline itself.
create or replace function private.sync_settle(p_room_id uuid)
returns void language sql volatile set search_path = '' as $$
  update public.sync_rounds
     set status = 'FINISHED', ended_at = started_at + duration_ms * interval '1 millisecond'
   where room_id = p_room_id and status = 'RUNNING'
     and clock_timestamp() > started_at + duration_ms * interval '1 millisecond'
$$;

-- Teams taking part in a round: rematch list, or every team that has members
-- (or already pressed). Teams created after the round closed are left out.
create or replace function private.sync_eligible_teams(r public.sync_rounds)
returns setof uuid language sql stable set search_path = '' as $$
  select t.id from public.teams t
  where t.room_id = r.room_id
    and (r.team_ids is null or t.id = any (r.team_ids))
    and (r.ended_at is null or t.created_at <= r.ended_at)
    and (exists (select 1 from public.team_members m where m.team_id = t.id)
         or exists (select 1 from public.sync_buzzes b where b.sync_round_id = r.id and b.team_id = t.id))
$$;

-- Full, authoritative results of a round (admin view). Ranking:
-- COMPLETE teams (both pressed) by gap_ms ascending, ties share a rank
-- (SQL rank(): 1, 1, 3). No hidden tie-breaker. Then PARTIAL, then NONE.
create or replace function private.sync_results(r public.sync_rounds)
returns jsonb language sql stable set search_path = '' as $$
  with t as (
    select tt.id, tt.team_name from public.teams tt
    where tt.id in (select private.sync_eligible_teams(r))
  ), m as (
    select b.team_id, b.participant_id, p.nickname as label, b.elapsed_ms
    from public.sync_buzzes b join public.participants p on p.id = b.participant_id
    where b.sync_round_id = r.id
    union all
    select tm.team_id, tm.participant_id, tm.member_label, null::integer
    from public.team_members tm
    where tm.team_id in (select id from t)
      and not exists (select 1 from public.sync_buzzes b
                      where b.sync_round_id = r.id and b.participant_id = tm.participant_id)
  ), agg as (
    select t.id, t.team_name,
           count(m.elapsed_ms) as pressed,
           case when count(m.elapsed_ms) = 2 then max(m.elapsed_ms) - min(m.elapsed_ms) end as gap_ms,
           coalesce(jsonb_agg(jsonb_build_object(
             'participant_id', m.participant_id, 'label', m.label, 'elapsed_ms', m.elapsed_ms)
             order by m.elapsed_ms nulls last, m.label) filter (where m.participant_id is not null),
             '[]'::jsonb) as members
    from t left join m on m.team_id = t.id
    group by t.id, t.team_name
  ), ranked as (
    select agg.*, case when gap_ms is not null
                       then rank() over (partition by gap_ms is null order by gap_ms) end as rnk
    from agg
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'team_id', id, 'team_name', team_name,
           'status', case pressed when 2 then 'COMPLETE' when 1 then 'PARTIAL' else 'NONE' end,
           'gap_ms', gap_ms, 'rank', rnk, 'members', members)
           order by rnk nulls last, pressed desc, team_name), '[]'::jsonb)
  from ranked
$$;

-- The part of the results that has been revealed by the host.
create or replace function private.sync_visible(r public.sync_rounds, p_results jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select case when r.id is null or r.status <> 'RESULTS' or r.revealed_rank is null then '[]'::jsonb
  else coalesce((
    select jsonb_agg(e order by ord)
    from jsonb_array_elements(p_results) with ordinality as x (e, ord)
    where ((e ->> 'rank') is not null
           and ((e ->> 'rank')::int >= r.revealed_rank or (e ->> 'rank')::int > 5))
       or ((e ->> 'rank') is null and r.revealed_rank = 1)
  ), '[]'::jsonb) end
$$;

create or replace function private.sync_progress(p_results jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'pressed', coalesce(sum((select count(*) from jsonb_array_elements(e -> 'members') mm
                             where mm ->> 'elapsed_ms' is not null)), 0),
    'expected', coalesce(sum(jsonb_array_length(e -> 'members')), 0))
  from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e
$$;

create or replace function private.sync_team_count(p_room_id uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.teams t
  where t.room_id = p_room_id and exists (select 1 from public.team_members m where m.team_id = t.id)
$$;

create or replace function private.sync_new_round(p_room_id uuid, p_status text, p_team_ids uuid[])
returns public.sync_rounds language sql volatile set search_path = '' as $$
  insert into public.sync_rounds (room_id, round_number, status, team_ids)
  values (p_room_id,
          coalesce((select max(round_number) from public.sync_rounds where room_id = p_room_id), 0) + 1,
          p_status, p_team_ids)
  returning *
$$;

-- token -> SYNC participant (null when unknown or not a sync member)
create or replace function private.sync_participant(p_token text)
returns public.participants language sql stable set search_path = '' as $$
  select p.* from private.participant_tokens t
  join public.participants p on p.id = t.participant_id
  where t.token_hash = private.hash_token(p_token) and p.kind = 'SYNC'
$$;

-- ---------------------------------------------------------------------
-- Buzzer RPCs updated to ignore SYNC participants
-- ---------------------------------------------------------------------

create or replace function public.get_public_state(p_room_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_round public.rounds;
begin
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  v_round := private.current_round(v_room.id);
  return jsonb_build_object(
    'room', private.room_json(v_room),
    'round', private.round_json(v_round),
    'participant_count', (select count(*) from public.participants
                          where room_id = v_room.id and is_active and not is_test and kind = 'BUZZER'),
    'recent_winners', coalesce((
      select jsonb_agg(jsonb_build_object('round_number', round_number, 'winner_nickname', winner_nickname)
                       order by round_number desc)
      from (select round_number, winner_nickname from public.rounds
            where room_id = v_room.id and winner_nickname is not null
            order by round_number desc limit 5) w), '[]'::jsonb),
    'server_time', now());
end $$;

create or replace function public.participant_sync(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_room public.rooms;
  v_round public.rounds;
begin
  select p.* into v_p from private.participant_tokens t
  join public.participants p on p.id = t.participant_id
  where t.token_hash = private.hash_token(p_token) and p.kind = 'BUZZER';
  if not found then return jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'error', 'KICKED'); end if;

  update public.participants set last_seen_at = now() where id = v_p.id;
  select * into v_room from public.rooms where id = v_p.room_id;
  v_round := private.current_round(v_room.id);

  return jsonb_build_object(
    'ok', true,
    'participant', jsonb_build_object('id', v_p.id, 'nickname', v_p.nickname),
    'room', private.room_json(v_room),
    'round', private.round_json(v_round),
    'me', jsonb_build_object(
      'attempted', exists (select 1 from public.buzz_attempts a
                           where a.round_id = v_round.id and a.arm_seq = v_round.arm_seq
                             and a.participant_id = v_p.id),
      'excluded', exists (select 1 from public.buzz_attempts a
                          where a.round_id = v_round.id and a.participant_id = v_p.id and a.revoked),
      'wins', (select count(*) from public.rounds r where r.room_id = v_room.id and r.winner_id = v_p.id)),
    'participant_count', (select count(*) from public.participants
                          where room_id = v_room.id and is_active and not is_test and kind = 'BUZZER'),
    'server_time', now());
end $$;

create or replace function public.buzz(p_token text, p_round_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_r public.rounds;
  v_attempt public.buzz_attempts;
  v_won boolean;
  v_arm integer;
  v_received timestamptz := clock_timestamp();
begin
  select p.* into v_p from private.participant_tokens t
  join public.participants p on p.id = t.participant_id
  where t.token_hash = private.hash_token(p_token) and p.kind = 'BUZZER';
  if not found then return jsonb_build_object('ok', false, 'result', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;

  select * into v_r from public.rounds where id = p_round_id;
  if not found or v_r.room_id <> v_p.room_id or v_r.status = 'FINISHED' then
    return jsonb_build_object('ok', false, 'result', 'STALE_ROUND');
  end if;
  if v_r.status in ('WAITING', 'READY') then
    return jsonb_build_object('ok', false, 'result', 'NOT_ARMED', 'round_id', v_r.id);
  end if;

  if exists (select 1 from public.buzz_attempts
             where round_id = v_r.id and participant_id = v_p.id and revoked) then
    return jsonb_build_object('ok', false, 'result', 'EXCLUDED', 'round_id', v_r.id);
  end if;

  select * into v_attempt from public.buzz_attempts
  where round_id = v_r.id and arm_seq = v_r.arm_seq and participant_id = v_p.id;
  if found then
    select * into v_r from public.rounds where id = v_r.id;
    return jsonb_build_object(
      'ok', true, 'duplicate', true,
      'result', case when v_attempt.accepted and not v_attempt.revoked then 'WON' else 'LOST' end,
      'round_id', v_r.id, 'winner_nickname', v_r.winner_nickname, 'winner_at', v_r.winner_at);
  end if;

  v_arm := v_r.arm_seq;

  update public.rounds
     set status = 'LOCKED', winner_id = v_p.id, winner_nickname = v_p.nickname, winner_at = v_received
   where id = p_round_id and status = 'ARMED' and winner_id is null and arm_seq = v_arm
  returning * into v_r;
  v_won := found;

  insert into public.buzz_attempts (round_id, arm_seq, participant_id, received_at, accepted)
  values (p_round_id, v_arm, v_p.id, v_received, v_won)
  on conflict (round_id, arm_seq, participant_id) do nothing;

  update public.participants set last_seen_at = now() where id = v_p.id;

  if v_won then
    return jsonb_build_object('ok', true, 'result', 'WON', 'round_id', v_r.id,
                              'winner_nickname', v_r.winner_nickname, 'winner_at', v_r.winner_at);
  end if;

  select * into v_r from public.rounds where id = p_round_id;
  return jsonb_build_object(
    'ok', true,
    'duplicate', v_r.winner_id = v_p.id,
    'result', case when v_r.winner_id = v_p.id then 'WON'
                   when v_r.winner_nickname is not null then 'LOST' else 'LOCKED' end,
    'round_id', v_r.id, 'winner_nickname', v_r.winner_nickname, 'winner_at', v_r.winner_at);
end $$;

create or replace function public.admin_get_state(p_admin_token text, p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_round public.rounds;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  v_round := private.current_round(v_room.id);

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'round', private.round_json(v_round),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'nickname', p.nickname, 'is_active', p.is_active, 'is_test', p.is_test,
        'joined_at', p.joined_at, 'last_seen_at', p.last_seen_at,
        'online', p.last_seen_at > now() - interval '30 seconds',
        'wins', (select count(*) from public.rounds r where r.winner_id = p.id)
      ) order by p.is_active desc, p.joined_at)
      from public.participants p where p.room_id = v_room.id and p.kind = 'BUZZER'), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(private.round_json(r) order by r.round_number desc)
      from public.rounds r where r.room_id = v_room.id), '[]'::jsonb),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nickname', p.nickname, 'received_at', a.received_at, 'arm_seq', a.arm_seq,
        'accepted', a.accepted, 'revoked', a.revoked) order by a.arm_seq desc, a.received_at, a.id)
      from public.buzz_attempts a join public.participants p on p.id = a.participant_id
      where a.round_id = v_round.id), '[]'::jsonb),
    'server_time', now());
end $$;

-- Whole-room reset now also clears the sync game (mode is kept).
create or replace function public.admin_reset_room(p_admin_token text, p_room_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  delete from public.rounds where room_id = p_room_id;
  delete from public.sync_rounds where room_id = p_room_id;
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
-- Sync participant RPCs
-- ---------------------------------------------------------------------

create or replace function public.sync_join(p_room_code text, p_team_name text, p_label text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_team public.teams;
  v_name text;
  v_label text;
  v_slot integer;
  v_pid uuid;
  v_token text := private.new_token();
begin
  v_name := private.clean_text(p_team_name, 10, 'TEAM_NAME');
  v_label := private.clean_text(p_label, 8, 'MEMBER_LABEL');
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.status <> 'OPEN' then raise exception 'ROOM_ENDED'; end if;
  if v_room.mode <> 'SYNC' then raise exception 'NOT_SYNC_MODE'; end if;
  if (select count(*) from public.participants where room_id = v_room.id and is_active) >= 200 then
    raise exception 'ROOM_FULL';
  end if;

  insert into public.teams (room_id, team_name) values (v_room.id, v_name)
  on conflict (room_id, (lower(team_name))) do nothing;
  -- the team row lock serialises concurrent joins to the same team
  select * into v_team from public.teams
  where room_id = v_room.id and lower(team_name) = lower(v_name) for update;

  select s into v_slot from generate_series(1, 2) s
  where not exists (select 1 from public.team_members where team_id = v_team.id and slot = s)
  order by s limit 1;
  if v_slot is null then raise exception 'TEAM_FULL'; end if;
  if exists (select 1 from public.team_members
             where team_id = v_team.id and lower(member_label) = lower(v_label)) then
    raise exception 'LABEL_TAKEN';
  end if;

  insert into public.participants (room_id, nickname, kind) values (v_room.id, v_label, 'SYNC')
  returning id into v_pid;
  insert into private.participant_tokens (participant_id, token_hash)
  values (v_pid, private.hash_token(v_token));
  begin
    insert into public.team_members (team_id, participant_id, member_label, slot)
    values (v_team.id, v_pid, v_label, v_slot);
  exception when unique_violation then
    raise exception 'TEAM_FULL';
  end;
  perform private.bump_room(v_room.id);

  return jsonb_build_object('participant_id', v_pid, 'token', v_token,
                            'team_id', v_team.id, 'team_name', v_team.team_name,
                            'label', v_label, 'room_id', v_room.id, 'room_code', v_room.room_code);
end $$;

-- Heartbeat + state for a sync team member (also restores after reload).
-- Never exposes the partner's press or any time before the host reveals.
create or replace function public.sync_state(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_m public.team_members;
  v_team public.teams;
  v_room public.rooms;
  v_r public.sync_rounds;
  v_results jsonb;
begin
  v_p := private.sync_participant(p_token);
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'error', 'KICKED'); end if;
  select * into v_m from public.team_members where participant_id = v_p.id;
  if not found then return jsonb_build_object('ok', false, 'error', 'KICKED'); end if;

  update public.participants set last_seen_at = now() where id = v_p.id;
  select * into v_team from public.teams where id = v_m.team_id;
  select * into v_room from public.rooms where id = v_p.room_id;
  perform private.sync_settle(v_room.id);
  v_r := private.sync_current_round(v_room.id);
  if v_r.status = 'RESULTS' then v_results := private.sync_results(v_r); end if;

  return jsonb_build_object(
    'ok', true,
    'participant', jsonb_build_object('id', v_p.id, 'label', v_m.member_label),
    'team', jsonb_build_object(
      'id', v_team.id, 'name', v_team.team_name,
      'members', (select jsonb_agg(jsonb_build_object(
                    'participant_id', p.id, 'label', m.member_label, 'me', p.id = v_p.id,
                    'online', p.id = v_p.id or p.last_seen_at > now() - interval '20 seconds')
                    order by m.slot)
                  from public.team_members m join public.participants p on p.id = m.participant_id
                  where m.team_id = v_team.id)),
    'room', private.room_json(v_room),
    'round', private.sync_round_json(v_r),
    'me', jsonb_build_object(
      'pressed', exists (select 1 from public.sync_buzzes b
                         where b.sync_round_id = v_r.id and b.participant_id = v_p.id),
      'eligible', v_r.id is null or v_r.team_ids is null or v_team.id = any (v_r.team_ids)),
    'results', private.sync_visible(v_r, v_results),
    'team_count', private.sync_team_count(v_room.id),
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- THE SYNC PRESS. Results:
--   ACCEPTED | DUPLICATE (already recorded: retries are safe)
--   TOO_EARLY (before GO, not recorded — may press again) | TOO_LATE | CLOSED
--   NOT_STARTED | NOT_ELIGIBLE | TEAM_DONE | STALE_ROUND | INVALID_TOKEN | KICKED
-- elapsed time is deliberately not returned before the reveal.
create or replace function public.sync_buzz(p_token text, p_round_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- taken first, before any lock wait, so queueing never inflates the time
  v_received timestamptz := clock_timestamp();
  v_p public.participants;
  v_m public.team_members;
  v_r public.sync_rounds;
  v_count integer;
  v_elapsed integer;
begin
  v_p := private.sync_participant(p_token);
  if v_p.id is null then return jsonb_build_object('ok', false, 'result', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;
  select * into v_m from public.team_members where participant_id = v_p.id;
  if not found then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;

  -- serialise presses of this round (cheap: one short transaction per press)
  select * into v_r from public.sync_rounds where id = p_round_id for update;
  if not found or v_r.room_id <> v_p.room_id
     or exists (select 1 from public.sync_rounds
                where room_id = v_r.room_id and round_number > v_r.round_number) then
    return jsonb_build_object('ok', false, 'result', 'STALE_ROUND');
  end if;

  if exists (select 1 from public.sync_buzzes where sync_round_id = v_r.id and participant_id = v_p.id) then
    return jsonb_build_object('ok', true, 'result', 'DUPLICATE', 'round_id', v_r.id);
  end if;
  if v_r.status in ('WAITING', 'READY') then
    return jsonb_build_object('ok', false, 'result', 'NOT_STARTED', 'round_id', v_r.id);
  end if;
  if v_r.status <> 'RUNNING' then
    return jsonb_build_object('ok', false, 'result', 'CLOSED', 'round_id', v_r.id);
  end if;
  if v_r.team_ids is not null and not (v_m.team_id = any (v_r.team_ids)) then
    return jsonb_build_object('ok', false, 'result', 'NOT_ELIGIBLE', 'round_id', v_r.id);
  end if;
  if v_received < v_r.started_at then
    return jsonb_build_object('ok', false, 'result', 'TOO_EARLY', 'round_id', v_r.id,
                              'wait_ms', ceil(extract(epoch from v_r.started_at - v_received) * 1000));
  end if;
  if v_received > v_r.started_at + v_r.duration_ms * interval '1 millisecond' then
    perform private.sync_settle(v_r.room_id);
    return jsonb_build_object('ok', false, 'result', 'TOO_LATE', 'round_id', v_r.id);
  end if;

  select count(*) into v_count from public.sync_buzzes
  where sync_round_id = v_r.id and team_id = v_m.team_id;
  if v_count >= 2 then
    return jsonb_build_object('ok', false, 'result', 'TEAM_DONE', 'round_id', v_r.id);
  end if;

  v_elapsed := least(round(extract(epoch from v_received - v_r.started_at) * 1000)::integer, v_r.duration_ms);
  insert into public.sync_buzzes (sync_round_id, team_id, participant_id, received_at, elapsed_ms, slot)
  values (v_r.id, v_m.team_id, v_p.id, v_received, v_elapsed, v_count + 1);
  update public.participants set last_seen_at = now() where id = v_p.id;

  -- everyone who can press has pressed => close the round now
  if not exists (
    select 1 from public.team_members tm
    where tm.team_id in (select private.sync_eligible_teams(v_r))
      and not exists (select 1 from public.sync_buzzes b
                      where b.sync_round_id = v_r.id and b.participant_id = tm.participant_id)
  ) then
    update public.sync_rounds set status = 'FINISHED', ended_at = v_received where id = v_r.id;
  end if;

  return jsonb_build_object('ok', true, 'result', 'ACCEPTED', 'round_id', v_r.id);
end $$;

-- Pick another family name before the round starts (typo fix).
create or replace function public.sync_leave(p_token text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_r public.sync_rounds;
begin
  v_p := private.sync_participant(p_token);
  if v_p.id is null or not v_p.is_active then return; end if;
  v_r := private.sync_current_round(v_p.room_id);
  if v_r.status = 'RUNNING' then raise exception 'SYNC_RUNNING'; end if;
  update public.participants set is_active = false where id = v_p.id;
  perform private.bump_room(v_p.room_id);
end $$;

-- /display: round state, team names, optional progress, revealed results.
create or replace function public.sync_public_state(p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_r public.sync_rounds;
  v_results jsonb;
begin
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform private.sync_settle(v_room.id);
  v_r := private.sync_current_round(v_room.id);
  if v_r.id is not null then v_results := private.sync_results(v_r); end if;

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'round', private.sync_round_json(v_r),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('team_name', t.team_name, 'members',
                         (select count(*) from public.team_members m where m.team_id = t.id))
                       order by t.created_at)
      from public.teams t
      where t.room_id = v_room.id and exists (select 1 from public.team_members m where m.team_id = t.id)),
      '[]'::jsonb),
    'progress', case when v_room.sync_show_progress and v_r.status in ('RUNNING', 'FINISHED')
                     then private.sync_progress(v_results) end,
    'results', private.sync_visible(v_r, v_results),
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- ---------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------

create or replace function public.admin_set_mode(p_admin_token text, p_room_id uuid, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_mode text := upper(btrim(coalesce(p_mode, '')));
begin
  perform private.require_admin(p_admin_token);
  v_room := private.lock_open_room(p_room_id);
  if v_mode not in ('BUZZER', 'SYNC') then raise exception 'INVALID_MODE'; end if;
  if v_mode = v_room.mode then return private.room_json(v_room); end if;
  if exists (select 1 from public.rounds where room_id = p_room_id and status = 'ARMED')
     or exists (select 1 from public.sync_rounds where room_id = p_room_id and status = 'RUNNING') then
    raise exception 'GAME_IN_PROGRESS';
  end if;
  if v_mode = 'SYNC' and not exists (select 1 from public.sync_rounds where room_id = p_room_id) then
    perform private.sync_new_round(p_room_id, 'WAITING', null);
  end if;
  update public.rooms set mode = v_mode, rev = rev + 1 where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

create or replace function public.admin_sync_state(p_admin_token text, p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_r public.sync_rounds;
  v_results jsonb;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform private.sync_settle(v_room.id);
  v_r := private.sync_current_round(v_room.id);
  v_results := case when v_r.id is null then '[]'::jsonb else private.sync_results(v_r) end;

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'round', private.sync_round_json(v_r),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.id, 'team_name', t.team_name,
        'members', (select jsonb_agg(jsonb_build_object(
                      'participant_id', p.id, 'label', m.member_label, 'slot', m.slot,
                      'is_test', p.is_test,
                      'online', p.last_seen_at > now() - interval '20 seconds',
                      'elapsed_ms', b.elapsed_ms) order by m.slot)
                    from public.team_members m
                    join public.participants p on p.id = m.participant_id
                    left join public.sync_buzzes b on b.sync_round_id = v_r.id and b.participant_id = p.id
                    where m.team_id = t.id)
      ) order by t.created_at)
      from public.teams t
      where t.room_id = v_room.id and exists (select 1 from public.team_members m where m.team_id = t.id)),
      '[]'::jsonb),
    'results', v_results,
    'progress', private.sync_progress(v_results),
    'rounds', coalesce((
      select jsonb_agg(private.sync_round_json(r) || jsonb_build_object(
               'winners', (select coalesce(jsonb_agg(e), '[]'::jsonb)
                           from jsonb_array_elements(private.sync_results(r)) e
                           where e ->> 'rank' = '1'))
             order by r.round_number desc)
      from public.sync_rounds r where r.room_id = v_room.id), '[]'::jsonb),
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- p_action: READY | START | FINISH | REVEAL_NEXT | REVEAL_ALL | NEXT
-- p_round_id must be the round the host is looking at (null only when the
-- room has no sync round yet), so a double click or stale screen is harmless.
create or replace function public.admin_sync_action(p_admin_token text, p_room_id uuid,
                                                    p_round_id uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_r public.sync_rounds;
  v_next integer;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  perform private.sync_settle(p_room_id);

  select * into v_r from public.sync_rounds
  where room_id = p_room_id order by round_number desc limit 1 for update;
  if not found then
    v_r := private.sync_new_round(p_room_id, 'WAITING', null);
  elsif p_round_id is distinct from v_r.id then
    raise exception 'ROUND_CHANGED';
  end if;

  case upper(p_action)
    when 'READY' then
      if v_r.status = 'WAITING' then
        update public.sync_rounds set status = 'READY' where id = v_r.id returning * into v_r;
      elsif v_r.status <> 'READY' then
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'START' then
      if v_r.status in ('WAITING', 'READY') then
        update public.sync_rounds
           set status = 'RUNNING', ended_at = null,
               started_at = clock_timestamp() + lead_ms * interval '1 millisecond'
         where id = v_r.id returning * into v_r;
      elsif v_r.status <> 'RUNNING' then
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'FINISH' then
      if v_r.status = 'RUNNING' then
        update public.sync_rounds
           set status = 'FINISHED',
               ended_at = greatest(started_at, least(clock_timestamp(), started_at + duration_ms * interval '1 millisecond'))
         where id = v_r.id returning * into v_r;
      elsif v_r.status not in ('FINISHED', 'RESULTS') then
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'REVEAL_NEXT' then
      if v_r.status not in ('FINISHED', 'RESULTS') then raise exception 'INVALID_TRANSITION'; end if;
      select max((e ->> 'rank')::int) into v_next
      from jsonb_array_elements(private.sync_results(v_r)) e
      where e ->> 'rank' is not null and (e ->> 'rank')::int <= 5
        and (v_r.revealed_rank is null or (e ->> 'rank')::int < v_r.revealed_rank);
      update public.sync_rounds
         set status = 'RESULTS', revealed_rank = coalesce(v_next, 1)
       where id = v_r.id returning * into v_r;
    when 'REVEAL_ALL' then
      if v_r.status not in ('FINISHED', 'RESULTS') then raise exception 'INVALID_TRANSITION'; end if;
      update public.sync_rounds set status = 'RESULTS', revealed_rank = 1
       where id = v_r.id returning * into v_r;
    when 'NEXT' then
      if v_r.status = 'RUNNING' then raise exception 'SYNC_RUNNING'; end if;
      v_r := private.sync_new_round(p_room_id, 'READY', null);
    else
      raise exception 'INVALID_ACTION';
  end case;

  return private.sync_round_json(v_r);
end $$;

-- Rematch for tied teams: a new round only those teams can play.
create or replace function public.admin_sync_rematch(p_admin_token text, p_room_id uuid,
                                                     p_round_id uuid, p_team_ids uuid[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_r public.sync_rounds;
  v_ids uuid[];
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  select * into v_r from public.sync_rounds
  where room_id = p_room_id order by round_number desc limit 1 for update;
  if not found or p_round_id is distinct from v_r.id then raise exception 'ROUND_CHANGED'; end if;
  if v_r.status not in ('FINISHED', 'RESULTS') then raise exception 'INVALID_TRANSITION'; end if;
  select array_agg(distinct t.id) into v_ids from public.teams t
  where t.room_id = p_room_id and t.id = any (p_team_ids);
  if v_ids is null or cardinality(v_ids) < 1 or cardinality(v_ids) <> cardinality(array(select distinct unnest(p_team_ids))) then
    raise exception 'INVALID_TEAMS';
  end if;
  v_r := private.sync_new_round(p_room_id, 'READY', v_ids);
  return private.sync_round_json(v_r);
end $$;

create or replace function public.admin_sync_set_progress(p_admin_token text, p_room_id uuid, p_show boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  update public.rooms set sync_show_progress = coalesce(p_show, false), rev = rev + 1
  where id = p_room_id returning * into v_room;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  return private.room_json(v_room);
end $$;

-- Wipe teams, members and sync rounds only (the quiz buzzer is untouched).
create or replace function public.admin_sync_reset(p_admin_token text, p_room_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_r public.sync_rounds;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  delete from public.sync_rounds where room_id = p_room_id;
  delete from public.participants where room_id = p_room_id and kind = 'SYNC';
  delete from public.teams where room_id = p_room_id;
  v_r := private.sync_new_round(p_room_id, 'WAITING', null);
  perform private.bump_room(p_room_id);
  return private.sync_round_json(v_r);
end $$;

-- Test mode: bot families of two. Tokens go back to the admin browser, which
-- presses through the exact same public.sync_buzz() path.
create or replace function public.admin_sync_add_test_teams(p_admin_token text, p_room_id uuid, p_count integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_result jsonb := '[]'::jsonb;
  v_team_id uuid;
  v_name text;
  v_pid uuid;
  v_token text;
  v_members jsonb;
  v_n integer := 0;
  v_added integer := 0;
begin
  perform private.require_admin(p_admin_token);
  v_room := private.lock_open_room(p_room_id);
  if not v_room.test_mode then raise exception 'TEST_MODE_OFF'; end if;
  if v_room.mode <> 'SYNC' then raise exception 'NOT_SYNC_MODE'; end if;
  if p_count is null or p_count < 1 or p_count > 15 then raise exception 'INVALID_COUNT'; end if;

  while v_added < p_count loop
    v_n := v_n + 1;
    v_name := '봇가족' || v_n;
    continue when exists (select 1 from public.teams where room_id = p_room_id and lower(team_name) = lower(v_name));
    insert into public.teams (room_id, team_name) values (p_room_id, v_name) returning id into v_team_id;
    v_members := '[]'::jsonb;
    for i in 1..2 loop
      v_token := private.new_token();
      insert into public.participants (room_id, nickname, kind, is_test)
      values (p_room_id, case i when 1 then '봇A' else '봇B' end, 'SYNC', true)
      returning id into v_pid;
      insert into private.participant_tokens (participant_id, token_hash)
      values (v_pid, private.hash_token(v_token));
      insert into public.team_members (team_id, participant_id, member_label, slot)
      values (v_team_id, v_pid, case i when 1 then '봇A' else '봇B' end, i);
      v_members := v_members || jsonb_build_array(jsonb_build_object('participant_id', v_pid, 'token', v_token));
    end loop;
    v_result := v_result || jsonb_build_array(jsonb_build_object('team_id', v_team_id, 'team_name', v_name, 'members', v_members));
    v_added := v_added + 1;
  end loop;
  perform private.bump_room(p_room_id);
  return v_result;
end $$;

-- ---------------------------------------------------------------------
-- Function privileges (re-applied for the whole API)
-- ---------------------------------------------------------------------

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.get_latest_room(),
  public.get_public_state(text),
  public.join_room(text, text),
  public.participant_sync(text),
  public.buzz(text, uuid),
  public.admin_login(text),
  public.admin_logout(text),
  public.admin_check(text),
  public.admin_list_rooms(text),
  public.admin_create_room(text),
  public.admin_get_state(text, text),
  public.admin_round_action(text, uuid, uuid, text),
  public.admin_cancel_win(text, uuid),
  public.admin_kick(text, uuid),
  public.admin_announce(text, uuid, text),
  public.admin_end_game(text, uuid),
  public.admin_reset_room(text, uuid),
  public.admin_set_test_mode(text, uuid, boolean),
  public.admin_add_test_bots(text, uuid, integer),
  public.admin_remove_test_bots(text, uuid),
  public.sync_join(text, text, text),
  public.sync_state(text),
  public.sync_buzz(text, uuid),
  public.sync_leave(text),
  public.sync_public_state(text),
  public.admin_set_mode(text, uuid, text),
  public.admin_sync_state(text, text),
  public.admin_sync_action(text, uuid, uuid, text),
  public.admin_sync_rematch(text, uuid, uuid, uuid[]),
  public.admin_sync_set_progress(text, uuid, boolean),
  public.admin_sync_reset(text, uuid),
  public.admin_sync_add_test_teams(text, uuid, integer)
to anon, authenticated;

-- Realtime: sync round state changes (no names or times in this table)
alter publication supabase_realtime add table public.sync_rounds;

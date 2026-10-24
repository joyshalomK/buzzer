-- =====================================================================
-- FM Family Quiz Buzzer — schema, security, and server-side game logic
-- =====================================================================
-- Security model
--   * The browser only holds the Supabase anon (publishable) key.
--   * Clients can never write tables directly. Every mutation goes through
--     a SECURITY DEFINER RPC below that validates a secret token.
--   * Participant tokens / admin session tokens are random 256-bit values.
--     Only their SHA-256 hash is stored (private schema, not exposed by API).
--   * The admin password is stored as a bcrypt hash in the private schema and
--     set from the Supabase SQL editor:  select private.set_admin_password('...');
--   * Anon may SELECT only `rooms` and `rounds` (no secrets in them) so that
--     Supabase Realtime postgres_changes can broadcast state changes.
--
-- Winner decision
--   * `public.buzz()` claims the round with a single conditional UPDATE
--     (... WHERE status = 'ARMED' AND winner_id IS NULL AND arm_seq = x).
--     PostgreSQL row locking serialises concurrent updaters; once one commits
--     the others re-check the WHERE clause and match 0 rows.
--   * A partial UNIQUE index on buzz_attempts guarantees at most one accepted
--     (non-revoked) attempt per round even if the logic above were wrong.
--   * Order = order in which the DB received/serialised requests. Client
--     timestamps are never used.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.rooms (
  id              uuid primary key default gen_random_uuid(),
  room_code       text not null unique check (room_code ~ '^[A-Z0-9]{4,8}$'),
  status          text not null default 'OPEN' check (status in ('OPEN', 'ENDED')),
  announcement    text check (char_length(announcement) <= 200),
  announcement_at timestamptz,
  test_mode       boolean not null default false,
  -- bumped whenever participants change so subscribers know to re-sync
  rev             bigint not null default 0,
  created_at      timestamptz not null default now()
);

create table public.participants (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms (id) on delete cascade,
  nickname     text not null check (char_length(nickname) between 1 and 12),
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_active    boolean not null default true,
  is_test      boolean not null default false,
  kicked_at    timestamptz
);
create index participants_room_idx on public.participants (room_id);
-- No duplicate nicknames among active participants of a room (case-insensitive).
create unique index participants_room_nickname_uq
  on public.participants (room_id, lower(nickname)) where is_active;

create table private.participant_tokens (
  participant_id uuid primary key references public.participants (id) on delete cascade,
  token_hash     bytea not null unique
);

create table public.rounds (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms (id) on delete cascade,
  round_number    integer not null check (round_number > 0),
  status          text not null default 'WAITING'
                  check (status in ('WAITING', 'READY', 'ARMED', 'LOCKED', 'FINISHED')),
  -- incremented each time the buzzer is armed (re-arming after a cancelled win)
  arm_seq         integer not null default 0,
  armed_at        timestamptz,
  winner_id       uuid references public.participants (id) on delete set null,
  winner_nickname text,
  winner_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (room_id, round_number),
  check (winner_at is null or status in ('LOCKED', 'FINISHED'))
);
create index rounds_room_idx on public.rounds (room_id, round_number desc);
-- At most one "current" (not finished) round per room.
create unique index rounds_one_current_per_room
  on public.rounds (room_id) where status <> 'FINISHED';

create table public.buzz_attempts (
  id             bigint generated always as identity primary key,
  round_id       uuid not null references public.rounds (id) on delete cascade,
  arm_seq        integer not null,
  participant_id uuid not null references public.participants (id) on delete cascade,
  received_at    timestamptz not null default clock_timestamp(),
  accepted       boolean not null default false,
  revoked        boolean not null default false,
  -- one attempt per participant per arming: dedupes double taps / retries
  unique (round_id, arm_seq, participant_id)
);
create index buzz_attempts_participant_idx on public.buzz_attempts (participant_id);
-- DB-level guarantee: never two (non-revoked) winners in the same round.
create unique index buzz_attempts_one_winner_per_round
  on public.buzz_attempts (round_id) where accepted and not revoked;

create table private.admin_config (
  id            boolean primary key default true check (id),
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

create table private.admin_sessions (
  token_hash bytea primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table private.admin_login_attempts (
  id           bigint generated always as identity primary key,
  attempted_at timestamptz not null default now(),
  success      boolean not null
);
create index admin_login_attempts_time_idx on private.admin_login_attempts (attempted_at);

-- ---------------------------------------------------------------------
-- Row level security & grants
-- ---------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.participants enable row level security;
alter table public.rounds enable row level security;
alter table public.buzz_attempts enable row level security;

revoke all on public.rooms, public.participants, public.rounds, public.buzz_attempts
  from anon, authenticated;

-- Read-only access needed by Realtime postgres_changes. No secrets live here.
grant select on public.rooms, public.rounds to anon, authenticated;
create policy rooms_public_read on public.rooms for select to anon, authenticated using (true);
create policy rounds_public_read on public.rounds for select to anon, authenticated using (true);
-- participants / buzz_attempts: no policies and no grants => no direct access.

-- ---------------------------------------------------------------------
-- Private helpers (not callable by API roles)
-- ---------------------------------------------------------------------

create or replace function private.hash_token(p_token text)
returns bytea language sql immutable set search_path = '' as $$
  select sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
$$;

create or replace function private.new_token()
returns text language sql volatile set search_path = '' as $$
  select encode(extensions.gen_random_bytes(32), 'hex')
$$;

create or replace function private.set_admin_password(p_password text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Admin password must be at least 8 characters';
  end if;
  insert into private.admin_config (id, password_hash, updated_at)
  values (true, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now())
  on conflict (id) do update
    set password_hash = excluded.password_hash, updated_at = now();
  -- changing the password logs out every existing admin session
  delete from private.admin_sessions;
end $$;

create or replace function private.require_admin(p_admin_token text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_admin_token is null or not exists (
    select 1 from private.admin_sessions
    where token_hash = private.hash_token(p_admin_token) and expires_at > now()
  ) then
    raise exception 'ADMIN_AUTH_REQUIRED' using errcode = '28000';
  end if;
end $$;

create or replace function private.gen_room_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  -- no 0/O/1/I/L to avoid confusion when read aloud
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where room_code = v_code);
  end loop;
  return v_code;
end $$;

create or replace function private.room_json(r public.rooms)
returns jsonb language sql stable set search_path = '' as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'room_code', r.room_code, 'status', r.status,
    'announcement', r.announcement, 'announcement_at', r.announcement_at,
    'test_mode', r.test_mode, 'rev', r.rev, 'created_at', r.created_at) end
$$;

create or replace function private.round_json(r public.rounds)
returns jsonb language sql stable set search_path = '' as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'room_id', r.room_id, 'round_number', r.round_number, 'status', r.status,
    'arm_seq', r.arm_seq, 'armed_at', r.armed_at, 'winner_id', r.winner_id,
    'winner_nickname', r.winner_nickname, 'winner_at', r.winner_at,
    'created_at', r.created_at) end
$$;

-- Current round = the unfinished one, or (after the game ended) the last one.
create or replace function private.current_round(p_room_id uuid)
returns public.rounds language sql stable set search_path = '' as $$
  select * from public.rounds
  where room_id = p_room_id
  order by (status <> 'FINISHED') desc, round_number desc
  limit 1
$$;

create or replace function private.bump_room(p_room_id uuid)
returns void language sql volatile set search_path = '' as $$
  update public.rooms set rev = rev + 1 where id = p_room_id
$$;

create or replace function private.lock_open_room(p_room_id uuid)
returns public.rooms language plpgsql volatile set search_path = '' as $$
declare v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.status <> 'OPEN' then raise exception 'ROOM_ENDED'; end if;
  return v_room;
end $$;

create or replace function private.clean_nickname(p_nickname text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  -- collapse whitespace, strip control characters
  v := btrim(regexp_replace(regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g'));
  if char_length(v) < 1 then raise exception 'NICKNAME_REQUIRED'; end if;
  if char_length(v) > 12 then raise exception 'NICKNAME_TOO_LONG'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Public (no auth) RPCs
-- ---------------------------------------------------------------------

create or replace function public.get_latest_room()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('room_code', room_code)
  from public.rooms where status = 'OPEN'
  order by created_at desc limit 1
$$;

-- Read-only state for the /display big screen.
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
                          where room_id = v_room.id and is_active and not is_test),
    'recent_winners', coalesce((
      select jsonb_agg(jsonb_build_object('round_number', round_number, 'winner_nickname', winner_nickname)
                       order by round_number desc)
      from (select round_number, winner_nickname from public.rounds
            where room_id = v_room.id and winner_nickname is not null
            order by round_number desc limit 5) w), '[]'::jsonb),
    'server_time', now());
end $$;

-- ---------------------------------------------------------------------
-- Participant RPCs
-- ---------------------------------------------------------------------

create or replace function public.join_room(p_room_code text, p_nickname text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_nick text;
  v_pid uuid;
  v_token text := private.new_token();
begin
  v_nick := private.clean_nickname(p_nickname);
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.status <> 'OPEN' then raise exception 'ROOM_ENDED'; end if;
  if (select count(*) from public.participants where room_id = v_room.id and is_active) >= 200 then
    raise exception 'ROOM_FULL';
  end if;

  begin
    insert into public.participants (room_id, nickname) values (v_room.id, v_nick)
    returning id into v_pid;
  exception when unique_violation then
    raise exception 'NICKNAME_TAKEN';
  end;
  insert into private.participant_tokens (participant_id, token_hash)
  values (v_pid, private.hash_token(v_token));
  perform private.bump_room(v_room.id);

  return jsonb_build_object('participant_id', v_pid, 'nickname', v_nick,
                            'room_id', v_room.id, 'room_code', v_room.room_code,
                            'token', v_token);
end $$;

-- Heartbeat + full state for a participant. Also used to restore after reload.
create or replace function public.participant_sync(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_room public.rooms;
  v_round public.rounds;
begin
  select p.* into v_p from private.participant_tokens t
  join public.participants p on p.id = t.participant_id
  where t.token_hash = private.hash_token(p_token);
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
                          where room_id = v_room.id and is_active and not is_test),
    'server_time', now());
end $$;

-- THE BUZZER. Server-side, atomic, idempotent.
-- Results: WON | LOST | LOCKED | NOT_ARMED | STALE_ROUND | EXCLUDED | INVALID_TOKEN | KICKED
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
  where t.token_hash = private.hash_token(p_token);
  if not found then return jsonb_build_object('ok', false, 'result', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;

  select * into v_r from public.rounds where id = p_round_id;
  if not found or v_r.room_id <> v_p.room_id or v_r.status = 'FINISHED' then
    -- request for a previous round arriving late: never touches the current round
    return jsonb_build_object('ok', false, 'result', 'STALE_ROUND');
  end if;
  if v_r.status in ('WAITING', 'READY') then
    return jsonb_build_object('ok', false, 'result', 'NOT_ARMED', 'round_id', v_r.id);
  end if;

  -- a winner whose win was cancelled by the host cannot buzz again this round
  if exists (select 1 from public.buzz_attempts
             where round_id = v_r.id and participant_id = v_p.id and revoked) then
    return jsonb_build_object('ok', false, 'result', 'EXCLUDED', 'round_id', v_r.id);
  end if;

  -- retry / double tap for the same arming => return the original outcome
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

  -- Atomic claim. Concurrent callers block on the row lock; after the first
  -- commits, the rest re-evaluate the WHERE clause and update nothing.
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
    -- winner_id = me: a concurrent duplicate of my own winning request
    'duplicate', v_r.winner_id = v_p.id,
    'result', case when v_r.winner_id = v_p.id then 'WON'
                   when v_r.winner_nickname is not null then 'LOST' else 'LOCKED' end,
    'round_id', v_r.id, 'winner_nickname', v_r.winner_nickname, 'winner_at', v_r.winner_at);
end $$;

-- ---------------------------------------------------------------------
-- Admin RPCs (every one starts with private.require_admin)
-- ---------------------------------------------------------------------

create or replace function public.admin_login(p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash text;
  v_token text;
  v_expires timestamptz := now() + interval '24 hours';
begin
  -- brute-force throttle: 10 failures per 5 minutes
  if (select count(*) from private.admin_login_attempts
      where not success and attempted_at > now() - interval '5 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS');
  end if;
  select password_hash into v_hash from private.admin_config where id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'ADMIN_NOT_CONFIGURED');
  end if;
  if p_password is null or extensions.crypt(p_password, v_hash) <> v_hash then
    insert into private.admin_login_attempts (success) values (false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_PASSWORD');
  end if;

  insert into private.admin_login_attempts (success) values (true);
  delete from private.admin_sessions where expires_at < now();
  v_token := private.new_token();
  insert into private.admin_sessions (token_hash, expires_at)
  values (private.hash_token(v_token), v_expires);
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires);
end $$;

create or replace function public.admin_logout(p_admin_token text)
returns void language sql volatile security definer set search_path = '' as $$
  delete from private.admin_sessions where token_hash = private.hash_token(p_admin_token)
$$;

create or replace function public.admin_check(p_admin_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin(p_admin_token);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_list_rooms(p_admin_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin(p_admin_token);
  return coalesce((select jsonb_agg(private.room_json(r) order by r.created_at desc)
                   from (select * from public.rooms order by created_at desc limit 20) r), '[]'::jsonb);
end $$;

create or replace function public.admin_create_room(p_admin_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  insert into public.rooms (room_code) values (private.gen_room_code()) returning * into v_room;
  insert into public.rounds (room_id, round_number, status) values (v_room.id, 1, 'WAITING');
  return private.room_json(v_room);
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
      from public.participants p where p.room_id = v_room.id), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(private.round_json(r) order by r.round_number desc)
      from public.rounds r where r.room_id = v_room.id), '[]'::jsonb),
    -- receipt order for the current round, useful for close calls
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nickname', p.nickname, 'received_at', a.received_at, 'arm_seq', a.arm_seq,
        'accepted', a.accepted, 'revoked', a.revoked) order by a.arm_seq desc, a.received_at, a.id)
      from public.buzz_attempts a join public.participants p on p.id = a.participant_id
      where a.round_id = v_round.id), '[]'::jsonb),
    'server_time', now());
end $$;

-- p_action: READY | ARM | LOCK | NEXT. p_round_id must be the round the admin
-- is looking at, so a double-click or a stale screen cannot skip a round.
create or replace function public.admin_round_action(p_admin_token text, p_room_id uuid,
                                                     p_round_id uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_round public.rounds;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);

  select * into v_round from public.rounds
  where room_id = p_room_id and status <> 'FINISHED' for update;
  if not found then
    insert into public.rounds (room_id, round_number, status)
    values (p_room_id, coalesce((select max(round_number) from public.rounds where room_id = p_room_id), 0) + 1, 'WAITING')
    returning * into v_round;
  end if;
  if p_round_id is distinct from v_round.id then
    raise exception 'ROUND_CHANGED';
  end if;

  case upper(p_action)
    when 'READY' then
      if v_round.status = 'WAITING' then
        update public.rounds set status = 'READY' where id = v_round.id returning * into v_round;
      elsif v_round.status <> 'READY' then
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'ARM' then
      if v_round.status in ('WAITING', 'READY') or (v_round.status = 'LOCKED' and v_round.winner_id is null and v_round.winner_nickname is null) then
        update public.rounds set status = 'ARMED', arm_seq = arm_seq + 1, armed_at = now()
        where id = v_round.id returning * into v_round;
      elsif v_round.status = 'LOCKED' then
        raise exception 'ROUND_HAS_WINNER';
      end if;
    when 'LOCK' then
      if v_round.status = 'ARMED' then
        update public.rounds set status = 'LOCKED' where id = v_round.id returning * into v_round;
      elsif v_round.status <> 'LOCKED' then
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'NEXT' then
      update public.rounds set status = 'FINISHED' where id = v_round.id;
      insert into public.rounds (room_id, round_number, status)
      values (p_room_id, v_round.round_number + 1, 'READY')
      returning * into v_round;
    else
      raise exception 'INVALID_ACTION';
  end case;

  return private.round_json(v_round);
end $$;

-- Cancel a win (e.g. wrong answer). The round becomes LOCKED without winner;
-- the host may re-arm it and the cancelled winner is excluded for that round.
create or replace function public.admin_cancel_win(p_admin_token text, p_round_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_round public.rounds;
begin
  perform private.require_admin(p_admin_token);
  select * into v_round from public.rounds where id = p_round_id for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;

  update public.buzz_attempts set revoked = true
  where round_id = p_round_id and accepted and not revoked;
  update public.rounds
     set winner_id = null, winner_nickname = null, winner_at = null
   where id = p_round_id
  returning * into v_round;
  return private.round_json(v_round);
end $$;

create or replace function public.admin_kick(p_admin_token text, p_participant_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid;
begin
  perform private.require_admin(p_admin_token);
  update public.participants set is_active = false, kicked_at = now()
  where id = p_participant_id returning room_id into v_room_id;
  if v_room_id is not null then perform private.bump_room(v_room_id); end if;
end $$;

create or replace function public.admin_announce(p_admin_token text, p_room_id uuid, p_text text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
begin
  perform private.require_admin(p_admin_token);
  if char_length(v_text) > 200 then raise exception 'ANNOUNCEMENT_TOO_LONG'; end if;
  update public.rooms set announcement = v_text,
         announcement_at = case when v_text is null then null else now() end
  where id = p_room_id returning * into v_room;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  return private.room_json(v_room);
end $$;

create or replace function public.admin_end_game(p_admin_token text, p_room_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  update public.rounds set status = 'FINISHED' where room_id = p_room_id and status <> 'FINISHED';
  update public.rooms set status = 'ENDED' where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

-- Before the event: wipe participants and rounds, keep the room code / QR.
create or replace function public.admin_reset_room(p_admin_token text, p_room_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  delete from public.rounds where room_id = p_room_id;
  delete from public.participants where room_id = p_room_id;
  insert into public.rounds (room_id, round_number, status) values (p_room_id, 1, 'WAITING');
  update public.rooms
     set status = 'OPEN', announcement = null, announcement_at = null, rev = rev + 1
   where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

create or replace function public.admin_set_test_mode(p_admin_token text, p_room_id uuid, p_enabled boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.rooms;
begin
  perform private.require_admin(p_admin_token);
  update public.rooms set test_mode = coalesce(p_enabled, false), rev = rev + 1
  where id = p_room_id returning * into v_room;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not v_room.test_mode then
    delete from public.participants where room_id = p_room_id and is_test;
  end if;
  return private.room_json(v_room);
end $$;

-- Test mode: create bot participants. Their tokens are returned to the admin
-- browser, which then buzzes through the exact same public.buzz() path.
create or replace function public.admin_add_test_bots(p_admin_token text, p_room_id uuid, p_count integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_result jsonb := '[]'::jsonb;
  v_pid uuid;
  v_token text;
  v_nick text;
  v_n integer := 0;
  v_added integer := 0;
begin
  perform private.require_admin(p_admin_token);
  v_room := private.lock_open_room(p_room_id);
  if not v_room.test_mode then raise exception 'TEST_MODE_OFF'; end if;
  if p_count is null or p_count < 1 or p_count > 30 then raise exception 'INVALID_COUNT'; end if;

  while v_added < p_count loop
    v_n := v_n + 1;
    v_nick := '테스트봇' || v_n;
    continue when exists (select 1 from public.participants
                          where room_id = p_room_id and is_active and lower(nickname) = lower(v_nick));
    v_token := private.new_token();
    insert into public.participants (room_id, nickname, is_test) values (p_room_id, v_nick, true)
    returning id into v_pid;
    insert into private.participant_tokens (participant_id, token_hash)
    values (v_pid, private.hash_token(v_token));
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'participant_id', v_pid, 'nickname', v_nick, 'token', v_token));
    v_added := v_added + 1;
  end loop;
  perform private.bump_room(p_room_id);
  return v_result;
end $$;

create or replace function public.admin_remove_test_bots(p_admin_token text, p_room_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin(p_admin_token);
  delete from public.participants where room_id = p_room_id and is_test;
  perform private.bump_room(p_room_id);
end $$;

-- ---------------------------------------------------------------------
-- Function privileges: nothing executable by default, then allow-list RPCs
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
  public.admin_remove_test_bots(text, uuid)
to anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: broadcast row changes of rooms/rounds (public data only)
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table public.rooms, public.rounds;

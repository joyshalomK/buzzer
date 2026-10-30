-- =====================================================================
-- FAMILY MATCH MODE — "우리 가족 이구동성"
-- =====================================================================
-- The two members of a family team each pick A or B for up to 10 questions.
-- Same pick = 1 point, different pick or a missing answer = 0 points.
-- There is no correct answer; only whether the family agreed.
--
-- Reuse
--   * Families are the FAMILY SYNC teams: public.teams / public.team_members
--     and participants with kind = 'SYNC' (a "family member" identity). The
--     same phone session plays both family games; a tie in this game can be
--     settled with a FAMILY SYNC final between the tied families.
--
-- Game flow (all transitions are admin-only, admin_match_action)
--   LOBBY -> QUESTION_READY -> QUESTION_OPEN -> QUESTION_CLOSED -> RESULT_REVEAL
--         -> (next question: QUESTION_READY ...) -> GAME_FINISHED
--   * OPEN starts the answer window on the server clock:
--     closes_at = opened_at + duration_seconds. Answers are accepted only
--     while the question is OPEN and the server receive time <= closes_at.
--   * Closing (deadline, or the host's early close) freezes the answers into
--     family_match_question_results in the same transaction. Scores are only
--     ever read from those rows (primary key question+team), never
--     incremented, so repeated/out-of-order events cannot double count.
--   * RESTART of a question deletes its answers and results and puts it
--     back to READY: the question is played again from scratch.
--   * NEW_GAME starts a separate game (copying the question set). Older
--     games keep their own answers and results under their own game_id.
--   * FINISH writes family_match_results. Total questions = questions
--     played (normally question_count; less only if the host ended early).
--     Unanswered questions count in the denominator.
--     Ranking is competition ranking (1, 1, 3) on matched_count.
--
-- Integrity / privacy
--   * Clients send only their secret token, the question id, A/B and a
--     client sequence number. Team and slot come from the token.
--   * One answer per member per question: UNIQUE (question_id, participant_id)
--     and UNIQUE (question_id, team_id, slot). Changing the answer updates
--     that row; a request with an older sequence number cannot overwrite a
--     newer one (requests overtaking each other on a bad network).
--   * Answers take a SHARE lock on the question row; closing takes an
--     exclusive lock. A close therefore waits for in-flight answers and
--     every answer after it sees CLOSED: no answer is half counted.
--   * Answer tables are not readable by clients and are not published to
--     Realtime. Only family_match_games (state, no answers) is published.
--     Participants get their partner's pick only after the host reveals it.
--     The host does not see picks while answering is open either.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------

alter table public.rooms drop constraint rooms_mode_check;
alter table public.rooms add constraint rooms_mode_check check (mode in ('BUZZER', 'SYNC', 'MATCH'));

create table public.family_match_games (
  id                  uuid primary key default gen_random_uuid(),
  room_id             uuid not null references public.rooms (id) on delete cascade,
  game_number         integer not null check (game_number > 0),
  title               text not null check (char_length(title) between 1 and 40),
  status              text not null default 'LOBBY'
                      check (status in ('LOBBY', 'QUESTION_READY', 'QUESTION_OPEN', 'QUESTION_CLOSED',
                                        'RESULT_REVEAL', 'GAME_FINISHED')),
  question_count      integer not null default 10 check (question_count between 1 and 10),
  -- 0 in the lobby, otherwise the question on screen
  current_question    integer not null default 0 check (current_question between 0 and 10),
  -- denominator of the final match rate, set when the game finishes
  total_questions     integer check (total_questions between 1 and 10),
  -- /display shows cumulative standings after each reveal
  show_standings      boolean not null default false,
  -- final ranking reveal: ranks >= this (and every rank > 3) are public
  final_revealed_rank integer check (final_revealed_rank >= 1),
  -- bumped on every change so Realtime always delivers an event
  rev                 integer not null default 0,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz,
  unique (room_id, game_number),
  check (current_question <= question_count)
);

create table public.family_match_questions (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references public.family_match_games (id) on delete cascade,
  question_number  integer not null check (question_number between 1 and 10),
  story_title      text not null check (char_length(story_title) between 1 and 40),
  story_text       text not null default '' check (char_length(story_text) <= 300),
  question_text    text not null check (char_length(question_text) between 1 and 100),
  option_a         text not null check (char_length(option_a) between 1 and 40),
  option_b         text not null check (char_length(option_b) between 1 and 40),
  duration_seconds integer not null default 15 check (duration_seconds between 5 and 30),
  status           text not null default 'PENDING'
                   check (status in ('PENDING', 'READY', 'OPEN', 'CLOSED', 'REVEALED')),
  opened_at        timestamptz,
  closes_at        timestamptz,
  closed_at        timestamptz,
  unique (game_id, question_number)
);

create table public.family_match_answers (
  id              bigint generated always as identity primary key,
  game_id         uuid not null references public.family_match_games (id) on delete cascade,
  question_id     uuid not null references public.family_match_questions (id) on delete cascade,
  team_id         uuid not null references public.teams (id) on delete cascade,
  participant_id  uuid not null references public.participants (id) on delete cascade,
  slot            smallint not null check (slot in (1, 2)),
  selected_option text not null check (selected_option in ('A', 'B')),
  -- client-side sequence of the request that set this value (newest wins)
  client_seq      bigint not null default 0,
  submitted_at    timestamptz not null,
  change_count    integer not null default 0,
  unique (question_id, participant_id),
  unique (question_id, team_id, slot)
);

-- Frozen per-question verdicts, written when the question closes.
create table public.family_match_question_results (
  game_id         uuid not null references public.family_match_games (id) on delete cascade,
  question_id     uuid not null references public.family_match_questions (id) on delete cascade,
  question_number integer not null,
  team_id         uuid not null references public.teams (id) on delete cascade,
  team_name       text not null,
  label_1         text,
  option_1        text,
  label_2         text,
  option_2        text,
  matched         boolean not null,
  points          smallint not null check (points in (0, 1)),
  primary key (question_id, team_id)
);
create index family_match_question_results_game_idx on public.family_match_question_results (game_id, team_id);

create table public.family_match_results (
  game_id          uuid not null references public.family_match_games (id) on delete cascade,
  team_id          uuid not null references public.teams (id) on delete cascade,
  team_name        text not null,
  matched_count    integer not null check (matched_count >= 0),
  total_questions  integer not null check (total_questions between 1 and 10),
  match_percentage numeric(4, 1) not null,
  final_rank       integer not null check (final_rank >= 1),
  primary key (game_id, team_id)
);

-- ---------------------------------------------------------------------
-- RLS & grants
-- ---------------------------------------------------------------------

alter table public.family_match_games enable row level security;
alter table public.family_match_questions enable row level security;
alter table public.family_match_answers enable row level security;
alter table public.family_match_question_results enable row level security;
alter table public.family_match_results enable row level security;

revoke all on public.family_match_games, public.family_match_questions, public.family_match_answers,
              public.family_match_question_results, public.family_match_results
  from anon, authenticated;

-- Game state only (no answers, no scores): needed by Realtime postgres_changes.
grant select on public.family_match_games to anon, authenticated;
create policy family_match_games_public_read on public.family_match_games
  for select to anon, authenticated using (true);
-- questions / answers / results: no grants, no policies => RPC only.

-- ---------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------

create or replace function private.match_game_json(g public.family_match_games)
returns jsonb language sql stable set search_path = '' as $$
  select case when g.id is null then null else jsonb_build_object(
    'id', g.id, 'room_id', g.room_id, 'game_number', g.game_number, 'title', g.title,
    'status', g.status, 'question_count', g.question_count, 'current_question', g.current_question,
    'total_questions', g.total_questions, 'show_standings', g.show_standings,
    'final_revealed_rank', g.final_revealed_rank, 'rev', g.rev,
    'created_at', g.created_at, 'finished_at', g.finished_at) end
$$;

create or replace function private.match_question_json(q public.family_match_questions)
returns jsonb language sql stable set search_path = '' as $$
  select case when q.id is null then null else jsonb_build_object(
    'id', q.id, 'question_number', q.question_number,
    'story_title', q.story_title, 'story_text', q.story_text, 'question_text', q.question_text,
    'option_a', q.option_a, 'option_b', q.option_b, 'duration_seconds', q.duration_seconds,
    'status', q.status,
    'opened_ms', private.epoch_ms(q.opened_at),
    'closes_ms', private.epoch_ms(q.closes_at),
    'closed_ms', private.epoch_ms(q.closed_at)) end
$$;

create or replace function private.match_current_game(p_room_id uuid)
returns public.family_match_games language sql stable set search_path = '' as $$
  select * from public.family_match_games where room_id = p_room_id order by game_number desc limit 1
$$;

create or replace function private.match_current_question(g public.family_match_games)
returns public.family_match_questions language sql stable set search_path = '' as $$
  select * from public.family_match_questions
  where game_id = g.id and question_number = g.current_question
$$;

-- The built-in storytelling set: "사라진 문화상품권 40장을 찾아라!"
create or replace function private.match_default_template()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'title', '사라진 문화상품권 40장을 찾아라!',
    'question_count', 10,
    'show_standings', false,
    'questions', (
      select jsonb_agg(jsonb_build_object(
               'story_title', s, 'story_text', '', 'question_text', q,
               'option_a', a, 'option_b', b, 'duration_seconds', 15) order by n)
      from (values
        (1, '사라진 선물 상자', '어디부터 살펴볼까요?', 'CCTV 확인하기', '주변 사람에게 물어보기'),
        (2, '복도에 남겨진 발자국', '어느 방으로 들어갈까요?', '웃음소리가 나는 방', '음악이 들리는 방'),
        (3, '수상한 식탁', '무엇을 먼저 먹을까요?', '치킨', '피자'),
        (4, '휴대폰 속 비밀 메시지', '무엇을 믿고 길을 찾을까요?', '스마트폰 지도', '부모님의 길 찾는 감각'),
        (5, '눈 내리는 거리', '어떻게 이동할까요?', '택시 타기', '걸어가기'),
        (6, '수상한 병원', '건강을 위해 무엇부터 할까요?', '건강검진 받기', '운동부터 하기'),
        (7, '의사 선생님의 비밀 봉투', '누구에게 도움을 청할까요?', '부모님', '자녀'),
        (8, '두 개의 보물상자', '어느 상자를 열까요?', '금색 상자', '은색 상자'),
        (9, '드디어 찾은 문화상품권!', '문화상품권을 어떻게 나눌까요?', '가족끼리 나누기', '게임으로 나누기'),
        (10, '우리 가족의 새해', '새해에 가족과 함께 하고 싶은 것은?', '가족여행 가기', '맛있는 음식 먹기')
      ) as d (n, s, q, a, b)))
$$;

-- Settings + question set of a game, used to start the next game with them.
create or replace function private.match_template(g public.family_match_games)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'title', g.title, 'question_count', g.question_count, 'show_standings', g.show_standings,
    'questions', (select jsonb_agg(jsonb_build_object(
                    'story_title', q.story_title, 'story_text', q.story_text,
                    'question_text', q.question_text, 'option_a', q.option_a, 'option_b', q.option_b,
                    'duration_seconds', q.duration_seconds) order by q.question_number)
                  from public.family_match_questions q where q.game_id = g.id))
$$;

create or replace function private.match_new_game(p_room_id uuid, p_template jsonb)
returns public.family_match_games language plpgsql volatile set search_path = '' as $$
declare
  v_t jsonb := coalesce(p_template, private.match_default_template());
  v_g public.family_match_games;
begin
  if jsonb_array_length(coalesce(v_t -> 'questions', '[]'::jsonb)) <> 10 then
    v_t := v_t || jsonb_build_object('questions', private.match_default_template() -> 'questions');
  end if;
  insert into public.family_match_games (room_id, game_number, title, question_count, show_standings)
  values (p_room_id,
          coalesce((select max(game_number) from public.family_match_games where room_id = p_room_id), 0) + 1,
          v_t ->> 'title', (v_t ->> 'question_count')::int, coalesce((v_t ->> 'show_standings')::boolean, false))
  returning * into v_g;
  insert into public.family_match_questions
    (game_id, question_number, story_title, story_text, question_text, option_a, option_b, duration_seconds)
  select v_g.id, x.ord, x.e ->> 'story_title', coalesce(x.e ->> 'story_text', ''), x.e ->> 'question_text',
         x.e ->> 'option_a', x.e ->> 'option_b', coalesce((x.e ->> 'duration_seconds')::int, 15)
  from jsonb_array_elements(v_t -> 'questions') with ordinality as x (e, ord);
  return v_g;
end $$;

-- Drop every game of the room and start game 1 again with the latest set.
create or replace function private.match_reset(p_room_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare v_t jsonb;
begin
  select private.match_template(g) into v_t from public.family_match_games g
  where g.room_id = p_room_id order by g.game_number desc limit 1;
  if v_t is null then return; end if;
  delete from public.family_match_games where room_id = p_room_id;
  perform private.match_new_game(p_room_id, v_t);
end $$;

-- Closes an OPEN question and freezes every family's verdict. The caller
-- holds the question row lock. Idempotent.
create or replace function private.match_close(p_question_id uuid, p_closed_at timestamptz)
returns void language plpgsql volatile set search_path = '' as $$
declare
  v_q public.family_match_questions;
  v_room_id uuid;
begin
  update public.family_match_questions set status = 'CLOSED', closed_at = p_closed_at
   where id = p_question_id and status = 'OPEN'
  returning * into v_q;
  if not found then return; end if;
  select room_id into v_room_id from public.family_match_games where id = v_q.game_id;

  -- every family that exists at closing time and has a member or an answer
  insert into public.family_match_question_results
    (game_id, question_id, question_number, team_id, team_name, label_1, option_1, label_2, option_2, matched, points)
  select v_q.game_id, v_q.id, v_q.question_number, t.id, t.team_name,
         coalesce(a1.label, m1.member_label), a1.selected_option,
         coalesce(a2.label, m2.member_label), a2.selected_option,
         coalesce(a1.selected_option = a2.selected_option, false),
         case when a1.selected_option = a2.selected_option then 1 else 0 end
  from public.teams t
  left join public.team_members m1 on m1.team_id = t.id and m1.slot = 1
  left join public.team_members m2 on m2.team_id = t.id and m2.slot = 2
  left join lateral (select p.nickname as label, a.selected_option
                     from public.family_match_answers a join public.participants p on p.id = a.participant_id
                     where a.question_id = v_q.id and a.team_id = t.id and a.slot = 1) a1 on true
  left join lateral (select p.nickname as label, a.selected_option
                     from public.family_match_answers a join public.participants p on p.id = a.participant_id
                     where a.question_id = v_q.id and a.team_id = t.id and a.slot = 2) a2 on true
  where t.room_id = v_room_id and t.created_at <= p_closed_at
    and (m1.id is not null or m2.id is not null or a1.selected_option is not null or a2.selected_option is not null)
  on conflict (question_id, team_id) do nothing;

  update public.family_match_games set status = 'QUESTION_CLOSED', rev = rev + 1
   where id = v_q.game_id and status = 'QUESTION_OPEN';
end $$;

-- OPEN questions past their deadline are closed. Called by every read, so
-- the time limit needs no cron job; match_answer checks the deadline itself.
-- Lock order everywhere: question row, then game row.
create or replace function private.match_settle(p_room_id uuid)
returns void language plpgsql volatile set search_path = '' as $$
declare v_q public.family_match_questions;
begin
  for v_q in
    select q.* from public.family_match_questions q
    join public.family_match_games g on g.id = q.game_id
    where g.room_id = p_room_id and q.status = 'OPEN' and clock_timestamp() > q.closes_at
    for update of q
  loop
    perform private.match_close(v_q.id, v_q.closes_at);
  end loop;
end $$;

-- Verdicts of one question with each family's running total.
create or replace function private.match_question_results(p_question_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'team_id', r.team_id, 'team_name', r.team_name,
           'label_1', r.label_1, 'option_1', r.option_1, 'label_2', r.label_2, 'option_2', r.option_2,
           'matched', r.matched, 'points', r.points,
           'total', (select sum(x.points) from public.family_match_question_results x
                     where x.game_id = r.game_id and x.team_id = r.team_id
                       and x.question_number <= r.question_number))
           order by r.team_name), '[]'::jsonb)
  from public.family_match_question_results r where r.question_id = p_question_id
$$;

-- Cumulative standings (competition ranking). p_revealed_only: count only
-- questions whose result the host has revealed (what the audience knows).
create or replace function private.match_standings(g public.family_match_games, p_revealed_only boolean)
returns jsonb language sql stable set search_path = '' as $$
  with s as (
    select r.team_id, max(r.team_name) as team_name, sum(r.points)::int as score, count(*)::int as played
    from public.family_match_question_results r
    join public.family_match_questions q on q.id = r.question_id
    where r.game_id = g.id and (not p_revealed_only or q.status = 'REVEALED')
    group by r.team_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'team_id', team_id, 'team_name', team_name, 'score', score, 'played', played, 'rank', rnk)
           order by rnk, team_name), '[]'::jsonb)
  from (select s.*, rank() over (order by score desc) as rnk from s) z
$$;

create or replace function private.match_finalize(g public.family_match_games)
returns void language sql volatile set search_path = '' as $$
  insert into public.family_match_results
    (game_id, team_id, team_name, matched_count, total_questions, match_percentage, final_rank)
  select g.id, s.team_id, s.team_name, s.score, g.total_questions,
         round(s.score * 100.0 / g.total_questions, 1),
         rank() over (order by s.score desc)
  from (select team_id, max(team_name) as team_name, sum(points)::int as score
        from public.family_match_question_results where game_id = g.id group by team_id) s
  on conflict (game_id, team_id) do nothing
$$;

create or replace function private.match_final(g public.family_match_games)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'team_id', team_id, 'team_name', team_name, 'matched_count', matched_count,
           'total_questions', total_questions, 'match_percentage', match_percentage, 'rank', final_rank)
           order by final_rank, team_name), '[]'::jsonb)
  from public.family_match_results where game_id = g.id
$$;

-- The part of the final ranking the host has revealed (3rd -> 1st).
create or replace function private.match_final_visible(g public.family_match_games, p_final jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select case when g.id is null or g.status <> 'GAME_FINISHED' or g.final_revealed_rank is null then '[]'::jsonb
  else coalesce((
    select jsonb_agg(e order by ord)
    from jsonb_array_elements(p_final) with ordinality as x (e, ord)
    where (e ->> 'rank')::int >= g.final_revealed_rank or (e ->> 'rank')::int > 3
  ), '[]'::jsonb) end
$$;

create or replace function private.match_progress(g public.family_match_games, q public.family_match_questions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'answered_teams', (select count(*) from (select team_id from public.family_match_answers
                                             where question_id = q.id group by team_id
                                             having count(*) = 2) x),
    'answered_people', (select count(*) from public.family_match_answers where question_id = q.id),
    'team_count', coalesce(private.sync_team_count(g.room_id), 0))
$$;

create or replace function private.match_text(p_text text, p_max integer, p_code text, p_optional boolean)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if p_optional and btrim(coalesce(p_text, '')) = '' then return ''; end if;
  return private.clean_text(p_text, p_max, p_code);
end $$;

-- Validates and stores one question of the editor.
create or replace function private.match_apply_question(p_game_id uuid, p_number integer, e jsonb)
returns void language plpgsql volatile set search_path = '' as $$
declare v_duration integer;
begin
  if e is null or jsonb_typeof(e) <> 'object' then raise exception 'INVALID_QUESTIONS'; end if;
  v_duration := case when (e ->> 'duration_seconds') ~ '^\d{1,3}$' then (e ->> 'duration_seconds')::int end;
  if v_duration is null or v_duration not between 5 and 30 then raise exception 'INVALID_DURATION'; end if;
  update public.family_match_questions
     set story_title = private.match_text(e ->> 'story_title', 40, 'STORY_TITLE', false),
         story_text = private.match_text(e ->> 'story_text', 300, 'STORY_TEXT', true),
         question_text = private.match_text(e ->> 'question_text', 100, 'QUESTION_TEXT', false),
         option_a = private.match_text(e ->> 'option_a', 40, 'OPTION', false),
         option_b = private.match_text(e ->> 'option_b', 40, 'OPTION', false),
         duration_seconds = v_duration
   where game_id = p_game_id and question_number = p_number;
  if not found then raise exception 'INVALID_QUESTIONS'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Existing functions extended for MATCH
-- ---------------------------------------------------------------------

create or replace function public.admin_set_mode(p_admin_token text, p_room_id uuid, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_mode text := upper(btrim(coalesce(p_mode, '')));
begin
  perform private.require_admin(p_admin_token);
  v_room := private.lock_open_room(p_room_id);
  if v_mode not in ('BUZZER', 'SYNC', 'MATCH') then raise exception 'INVALID_MODE'; end if;
  if v_mode = v_room.mode then return private.room_json(v_room); end if;
  perform private.sync_settle(p_room_id);
  perform private.match_settle(p_room_id);
  if exists (select 1 from public.rounds where room_id = p_room_id and status = 'ARMED')
     or exists (select 1 from public.sync_rounds where room_id = p_room_id and status = 'RUNNING')
     or exists (select 1 from public.family_match_games where room_id = p_room_id and status = 'QUESTION_OPEN') then
    raise exception 'GAME_IN_PROGRESS';
  end if;
  if v_mode = 'SYNC' and not exists (select 1 from public.sync_rounds where room_id = p_room_id) then
    perform private.sync_new_round(p_room_id, 'WAITING', null);
  end if;
  if v_mode = 'MATCH' and not exists (select 1 from public.family_match_games where room_id = p_room_id) then
    perform private.match_new_game(p_room_id, null);
  end if;
  update public.rooms set mode = v_mode, rev = rev + 1 where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

-- Family teams are shared by FAMILY SYNC and FAMILY MATCH.
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
  if v_room.mode not in ('SYNC', 'MATCH') then raise exception 'NOT_SYNC_MODE'; end if;
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
  perform private.match_settle(v_p.room_id);
  if exists (select 1 from public.family_match_games
             where room_id = v_p.room_id and status = 'QUESTION_OPEN') then
    raise exception 'MATCH_OPEN';
  end if;
  update public.participants set is_active = false where id = v_p.id;
  perform private.bump_room(v_p.room_id);
end $$;

-- Whole-room reset also restarts the family match (question set is kept).
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
  delete from public.participants where room_id = p_room_id;
  delete from public.teams where room_id = p_room_id;
  insert into public.rounds (room_id, round_number, status) values (p_room_id, 1, 'WAITING');
  perform private.sync_new_round(p_room_id, 'WAITING', null);
  update public.rooms
     set status = 'OPEN', announcement = null, announcement_at = null, rev = rev + 1
   where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
end $$;

-- Removing all families also restarts the family match (its scores belong to them).
create or replace function public.admin_sync_reset(p_admin_token text, p_room_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_r public.sync_rounds;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  delete from public.sync_rounds where room_id = p_room_id;
  perform private.match_reset(p_room_id);
  delete from public.participants where room_id = p_room_id and kind = 'SYNC';
  delete from public.teams where room_id = p_room_id;
  v_r := private.sync_new_round(p_room_id, 'WAITING', null);
  perform private.bump_room(p_room_id);
  return private.sync_round_json(v_r);
end $$;

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
  if v_room.mode not in ('SYNC', 'MATCH') then raise exception 'NOT_SYNC_MODE'; end if;
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
-- Participant RPCs
-- ---------------------------------------------------------------------

-- Heartbeat + state for a family member (also restores after reload).
-- Only the caller's own pick is returned until the host reveals the result.
create or replace function public.match_state(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p public.participants;
  v_m public.team_members;
  v_team public.teams;
  v_room public.rooms;
  v_g public.family_match_games;
  v_q public.family_match_questions;
  v_mine public.family_match_answers;
  v_res public.family_match_question_results;
  v_partner jsonb;
  v_final jsonb := '[]'::jsonb;
begin
  v_p := private.sync_participant(p_token);
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'error', 'KICKED'); end if;
  select * into v_m from public.team_members where participant_id = v_p.id;
  if not found then return jsonb_build_object('ok', false, 'error', 'KICKED'); end if;

  update public.participants set last_seen_at = now() where id = v_p.id;
  select * into v_team from public.teams where id = v_m.team_id;
  select * into v_room from public.rooms where id = v_p.room_id;
  perform private.match_settle(v_room.id);
  v_g := private.match_current_game(v_room.id);
  v_q := private.match_current_question(v_g);
  select * into v_mine from public.family_match_answers where question_id = v_q.id and participant_id = v_p.id;

  if v_q.status = 'REVEALED' then
    select * into v_res from public.family_match_question_results where question_id = v_q.id and team_id = v_team.id;
    select jsonb_build_object('label', p.nickname, 'option', a.selected_option) into v_partner
    from public.family_match_answers a join public.participants p on p.id = a.participant_id
    where a.question_id = v_q.id and a.team_id = v_team.id and a.participant_id <> v_p.id;
  end if;
  if v_g.status = 'GAME_FINISHED' then
    v_final := private.match_final_visible(v_g, private.match_final(v_g));
  end if;

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
    'game', private.match_game_json(v_g),
    'question', private.match_question_json(v_q),
    'me', jsonb_build_object('answer', v_mine.selected_option, 'seq', v_mine.client_seq),
    'reveal', case when v_q.status = 'REVEALED' then jsonb_build_object(
                'mine', v_mine.selected_option,
                'partner', v_partner,
                'matched', coalesce(v_res.matched, false),
                'points', coalesce(v_res.points, 0)) end,
    'score', (select coalesce(sum(r.points), 0) from public.family_match_question_results r
              join public.family_match_questions q on q.id = r.question_id
              where r.game_id = v_g.id and r.team_id = v_team.id and q.status = 'REVEALED'),
    'final', v_final,
    'team_count', private.sync_team_count(v_room.id),
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- THE ANSWER. Results:
--   ACCEPTED (option = what is stored now) | STALE (an answer with a newer
--   p_seq is already stored; option = that answer) | NOT_OPEN | TOO_LATE |
--   CLOSED | STALE_QUESTION | INVALID_OPTION | INVALID_TOKEN | KICKED
create or replace function public.match_answer(p_token text, p_question_id uuid, p_option text, p_seq bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_received timestamptz := clock_timestamp();
  v_p public.participants;
  v_m public.team_members;
  v_q public.family_match_questions;
  v_g public.family_match_games;
  v_opt text := upper(btrim(coalesce(p_option, '')));
  v_seq bigint := coalesce(p_seq, 0);
  v_stored public.family_match_answers;
begin
  v_p := private.sync_participant(p_token);
  if v_p.id is null then return jsonb_build_object('ok', false, 'result', 'INVALID_TOKEN'); end if;
  if not v_p.is_active then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;
  select * into v_m from public.team_members where participant_id = v_p.id;
  if not found then return jsonb_build_object('ok', false, 'result', 'KICKED'); end if;
  if v_opt not in ('A', 'B') then return jsonb_build_object('ok', false, 'result', 'INVALID_OPTION'); end if;

  -- SHARE: answers run in parallel; closing (FOR UPDATE) waits for them
  select * into v_q from public.family_match_questions where id = p_question_id for share;
  if not found then return jsonb_build_object('ok', false, 'result', 'STALE_QUESTION'); end if;
  select * into v_g from public.family_match_games where id = v_q.game_id;
  if v_g.room_id <> v_p.room_id or v_g.id <> (private.match_current_game(v_p.room_id)).id
     or v_q.question_number <> v_g.current_question then
    return jsonb_build_object('ok', false, 'result', 'STALE_QUESTION');
  end if;
  if v_q.status in ('PENDING', 'READY') then
    return jsonb_build_object('ok', false, 'result', 'NOT_OPEN', 'question_id', v_q.id);
  end if;
  select * into v_stored from public.family_match_answers where question_id = v_q.id and participant_id = v_p.id;
  if v_q.status <> 'OPEN' then
    return jsonb_build_object('ok', false, 'result', 'CLOSED', 'question_id', v_q.id, 'option', v_stored.selected_option);
  end if;
  if v_received > v_q.closes_at then
    return jsonb_build_object('ok', false, 'result', 'TOO_LATE', 'question_id', v_q.id, 'option', v_stored.selected_option);
  end if;

  insert into public.family_match_answers as a
    (game_id, question_id, team_id, participant_id, slot, selected_option, client_seq, submitted_at)
  values (v_g.id, v_q.id, v_m.team_id, v_p.id, v_m.slot, v_opt, v_seq, v_received)
  on conflict (question_id, team_id, slot) do update
     set participant_id = excluded.participant_id,
         selected_option = excluded.selected_option,
         client_seq = excluded.client_seq,
         submitted_at = excluded.submitted_at,
         change_count = a.change_count + (a.selected_option <> excluded.selected_option)::int
   where a.participant_id <> excluded.participant_id or excluded.client_seq > a.client_seq
  returning * into v_stored;

  if not found then
    -- same or newer request already stored (retry, or requests overtook each other)
    select * into v_stored from public.family_match_answers where question_id = v_q.id and participant_id = v_p.id;
    update public.participants set last_seen_at = now() where id = v_p.id;
    return jsonb_build_object('ok', true,
                              'result', case when v_stored.client_seq = v_seq then 'ACCEPTED' else 'STALE' end,
                              'question_id', v_q.id, 'option', v_stored.selected_option);
  end if;
  update public.participants set last_seen_at = now() where id = v_p.id;
  return jsonb_build_object('ok', true, 'result', 'ACCEPTED', 'question_id', v_q.id, 'option', v_stored.selected_option);
end $$;

-- /display: question, answer progress, revealed verdicts, optional
-- standings (revealed questions only) and the revealed final ranking.
create or replace function public.match_public_state(p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_g public.family_match_games;
  v_q public.family_match_questions;
begin
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform private.match_settle(v_room.id);
  v_g := private.match_current_game(v_room.id);
  v_q := private.match_current_question(v_g);

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'game', private.match_game_json(v_g),
    'question', private.match_question_json(v_q),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('team_name', t.team_name, 'members',
                         (select count(*) from public.team_members m where m.team_id = t.id))
                       order by t.created_at)
      from public.teams t
      where t.room_id = v_room.id and exists (select 1 from public.team_members m where m.team_id = t.id)),
      '[]'::jsonb),
    'progress', case when v_q.status in ('OPEN', 'CLOSED', 'REVEALED') then private.match_progress(v_g, v_q) end,
    'results', case when v_q.status = 'REVEALED' then private.match_question_results(v_q.id) else '[]'::jsonb end,
    -- never during the last question or after it: that would give away the final ranking
    'standings', case when v_g.show_standings and v_g.status <> 'GAME_FINISHED'
                           and v_g.current_question < v_g.question_count
                      then private.match_standings(v_g, true) else '[]'::jsonb end,
    'final', case when v_g.status = 'GAME_FINISHED'
                  then private.match_final_visible(v_g, private.match_final(v_g)) else '[]'::jsonb end,
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- ---------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------

create or replace function public.admin_match_state(p_admin_token text, p_room_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_g public.family_match_games;
  v_q public.family_match_questions;
begin
  perform private.require_admin(p_admin_token);
  select * into v_room from public.rooms where room_code = upper(btrim(p_room_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform private.match_settle(v_room.id);
  v_g := private.match_current_game(v_room.id);
  v_q := private.match_current_question(v_g);

  return jsonb_build_object(
    'room', private.room_json(v_room),
    'game', private.match_game_json(v_g),
    'question', private.match_question_json(v_q),
    'questions', coalesce((select jsonb_agg(private.match_question_json(q) order by q.question_number)
                           from public.family_match_questions q where q.game_id = v_g.id), '[]'::jsonb),
    -- answer counts only: nobody, not even the host, sees picks while answering is open
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.id, 'team_name', t.team_name,
        'answered', (select count(*) from public.family_match_answers a
                     where a.question_id = v_q.id and a.team_id = t.id),
        'members', (select jsonb_agg(jsonb_build_object(
                      'participant_id', p.id, 'label', m.member_label, 'slot', m.slot,
                      'is_test', p.is_test,
                      'online', p.last_seen_at > now() - interval '20 seconds',
                      'answered', exists (select 1 from public.family_match_answers a
                                          where a.question_id = v_q.id and a.participant_id = p.id))
                      order by m.slot)
                    from public.team_members m join public.participants p on p.id = m.participant_id
                    where m.team_id = t.id)
      ) order by t.created_at)
      from public.teams t
      where t.room_id = v_room.id and exists (select 1 from public.team_members m where m.team_id = t.id)),
      '[]'::jsonb),
    'progress', private.match_progress(v_g, v_q),
    'results', case when v_q.status in ('CLOSED', 'REVEALED') then private.match_question_results(v_q.id)
                    else '[]'::jsonb end,
    'standings', private.match_standings(v_g, false),
    'final', private.match_final(v_g),
    'games', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'game_number', x.game_number, 'title', x.title, 'status', x.status,
               'question_count', x.question_count, 'current_question', x.current_question,
               'total_questions', x.total_questions, 'finished_at', x.finished_at,
               'winners', (select coalesce(jsonb_agg(r.team_name order by r.team_name), '[]'::jsonb)
                           from public.family_match_results r where r.game_id = x.id and r.final_rank = 1))
             order by x.game_number desc)
      from public.family_match_games x where x.room_id = v_room.id), '[]'::jsonb),
    'server_now_ms', private.epoch_ms(clock_timestamp()));
end $$;

-- p_action: PREPARE | OPEN | CLOSE | REVEAL | NEXT | RESTART | FINISH
--           | REVEAL_FINAL_NEXT | REVEAL_FINAL_ALL | NEW_GAME
-- p_game_id / p_expected_question must match what the host is looking at
-- (null game only when the room has no game yet), so a double click or a
-- stale screen cannot skip a question.
create or replace function public.admin_match_action(p_admin_token text, p_room_id uuid, p_game_id uuid,
                                                     p_expected_question integer, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_g public.family_match_games;
  v_q public.family_match_questions;
  v_next integer;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  perform private.match_settle(p_room_id);

  v_g := private.match_current_game(p_room_id);
  if v_g.id is null then
    v_g := private.match_new_game(p_room_id, null);
  elsif p_game_id is distinct from v_g.id or p_expected_question is distinct from v_g.current_question then
    raise exception 'ROUND_CHANGED';
  end if;
  -- lock order: question, then game (same as match_settle)
  select * into v_q from public.family_match_questions
  where game_id = v_g.id and question_number = v_g.current_question for update;
  select * into v_g from public.family_match_games where id = v_g.id for update;

  case upper(coalesce(p_action, ''))
    when 'PREPARE' then
      if v_g.status <> 'LOBBY' then raise exception 'INVALID_TRANSITION'; end if;
      update public.family_match_questions set status = 'READY' where game_id = v_g.id and question_number = 1;
      update public.family_match_games set status = 'QUESTION_READY', current_question = 1, rev = rev + 1
       where id = v_g.id returning * into v_g;
    when 'NEXT' then
      if v_g.status not in ('QUESTION_CLOSED', 'RESULT_REVEAL') or v_g.current_question >= v_g.question_count then
        raise exception 'INVALID_TRANSITION';
      end if;
      -- a result the host skipped counts as revealed once the game moves on
      update public.family_match_questions set status = 'REVEALED' where id = v_q.id and status = 'CLOSED';
      update public.family_match_questions set status = 'READY'
       where game_id = v_g.id and question_number = v_g.current_question + 1;
      update public.family_match_games set status = 'QUESTION_READY', current_question = current_question + 1, rev = rev + 1
       where id = v_g.id returning * into v_g;
    when 'OPEN' then
      if v_g.status <> 'QUESTION_READY' then raise exception 'INVALID_TRANSITION'; end if;
      update public.family_match_questions
         set status = 'OPEN', opened_at = clock_timestamp(),
             closes_at = clock_timestamp() + duration_seconds * interval '1 second', closed_at = null
       where id = v_q.id;
      update public.family_match_games set status = 'QUESTION_OPEN', rev = rev + 1
       where id = v_g.id returning * into v_g;
    when 'CLOSE' then
      if v_g.status = 'QUESTION_OPEN' then
        perform private.match_close(v_q.id, least(clock_timestamp(), v_q.closes_at));
        select * into v_g from public.family_match_games where id = v_g.id;
      elsif v_g.status <> 'QUESTION_CLOSED' then  -- already closed by the timer: nothing to do
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'REVEAL' then
      if v_g.status = 'QUESTION_CLOSED' then
        update public.family_match_questions set status = 'REVEALED' where id = v_q.id;
        update public.family_match_games set status = 'RESULT_REVEAL', rev = rev + 1
         where id = v_g.id returning * into v_g;
      elsif v_g.status <> 'RESULT_REVEAL' then
        raise exception 'INVALID_TRANSITION';
      end if;
    when 'RESTART' then
      -- replay the current question: its answers and verdicts are discarded
      if v_g.status not in ('QUESTION_OPEN', 'QUESTION_CLOSED', 'RESULT_REVEAL') then
        raise exception 'INVALID_TRANSITION';
      end if;
      delete from public.family_match_answers where question_id = v_q.id;
      delete from public.family_match_question_results where question_id = v_q.id;
      update public.family_match_questions
         set status = 'READY', opened_at = null, closes_at = null, closed_at = null
       where id = v_q.id;
      update public.family_match_games set status = 'QUESTION_READY', rev = rev + 1
       where id = v_g.id returning * into v_g;
    when 'FINISH' then
      -- normally after the last question; earlier = the host ends the game here
      if v_g.status not in ('QUESTION_CLOSED', 'RESULT_REVEAL') then raise exception 'INVALID_TRANSITION'; end if;
      update public.family_match_questions set status = 'REVEALED' where id = v_q.id and status = 'CLOSED';
      update public.family_match_games
         set status = 'GAME_FINISHED', total_questions = current_question, finished_at = now(),
             final_revealed_rank = null, rev = rev + 1
       where id = v_g.id returning * into v_g;
      perform private.match_finalize(v_g);
    when 'REVEAL_FINAL_NEXT' then
      if v_g.status <> 'GAME_FINISHED' then raise exception 'INVALID_TRANSITION'; end if;
      select max(final_rank) into v_next from public.family_match_results
      where game_id = v_g.id and final_rank <= 3
        and (v_g.final_revealed_rank is null or final_rank < v_g.final_revealed_rank);
      update public.family_match_games set final_revealed_rank = coalesce(v_next, 1), rev = rev + 1
       where id = v_g.id returning * into v_g;
    when 'REVEAL_FINAL_ALL' then
      if v_g.status <> 'GAME_FINISHED' then raise exception 'INVALID_TRANSITION'; end if;
      update public.family_match_games set final_revealed_rank = 1, rev = rev + 1
       where id = v_g.id returning * into v_g;
    when 'NEW_GAME' then
      if v_g.status = 'QUESTION_OPEN' then raise exception 'MATCH_OPEN'; end if;
      v_g := private.match_new_game(p_room_id, private.match_template(v_g));
    else
      raise exception 'INVALID_ACTION';
  end case;

  return private.match_game_json(v_g);
end $$;

-- Lobby setup: title, number of questions and the whole question set
-- (exactly 10 entries in play order; entries after question_count are kept
-- for later games).
create or replace function public.admin_match_setup(p_admin_token text, p_room_id uuid, p_game_id uuid,
                                                    p_title text, p_question_count integer, p_questions jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_g public.family_match_games;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  v_g := private.match_current_game(p_room_id);
  if v_g.id is null or p_game_id is distinct from v_g.id then raise exception 'ROUND_CHANGED'; end if;
  select * into v_g from public.family_match_games where id = v_g.id for update;
  if v_g.status <> 'LOBBY' then raise exception 'INVALID_TRANSITION'; end if;
  if p_question_count is null or p_question_count not between 1 and 10 then raise exception 'INVALID_COUNT'; end if;
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) <> 10 then
    raise exception 'INVALID_QUESTIONS';
  end if;
  for i in 1..10 loop
    perform private.match_apply_question(v_g.id, i, p_questions -> (i - 1));
  end loop;
  update public.family_match_games
     set title = private.clean_text(p_title, 40, 'GAME_TITLE'), question_count = p_question_count, rev = rev + 1
   where id = v_g.id returning * into v_g;
  return private.match_game_json(v_g);
end $$;

-- Fix one question during the game (only before it opens).
create or replace function public.admin_match_edit_question(p_admin_token text, p_room_id uuid, p_game_id uuid,
                                                            p_question_number integer, p_question jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_g public.family_match_games;
  v_q public.family_match_questions;
begin
  perform private.require_admin(p_admin_token);
  perform private.lock_open_room(p_room_id);
  v_g := private.match_current_game(p_room_id);
  if v_g.id is null or p_game_id is distinct from v_g.id then raise exception 'ROUND_CHANGED'; end if;
  select * into v_q from public.family_match_questions
  where game_id = v_g.id and question_number = p_question_number for update;
  if not found then raise exception 'INVALID_QUESTIONS'; end if;
  if v_q.status not in ('PENDING', 'READY') then raise exception 'QUESTION_LOCKED'; end if;
  perform private.match_apply_question(v_g.id, p_question_number, p_question);
  update public.family_match_games set rev = rev + 1 where id = v_g.id;
  select * into v_q from public.family_match_questions where id = v_q.id;
  return private.match_question_json(v_q);
end $$;

create or replace function public.admin_match_set_standings(p_admin_token text, p_room_id uuid, p_show boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_g public.family_match_games;
begin
  perform private.require_admin(p_admin_token);
  v_g := private.match_current_game(p_room_id);
  if v_g.id is null then raise exception 'ROUND_CHANGED'; end if;
  update public.family_match_games set show_standings = coalesce(p_show, false), rev = rev + 1
   where id = v_g.id returning * into v_g;
  return private.match_game_json(v_g);
end $$;

-- Tie in the final ranking: switch to FAMILY SYNC with a round only the
-- given (tied) families can play.
create or replace function public.admin_match_sync_final(p_admin_token text, p_room_id uuid, p_game_id uuid,
                                                         p_team_ids uuid[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_g public.family_match_games;
  v_ids uuid[];
begin
  perform private.require_admin(p_admin_token);
  v_room := private.lock_open_room(p_room_id);
  v_g := private.match_current_game(p_room_id);
  if v_g.id is null or p_game_id is distinct from v_g.id then raise exception 'ROUND_CHANGED'; end if;
  if v_g.status <> 'GAME_FINISHED' then raise exception 'INVALID_TRANSITION'; end if;
  select array_agg(distinct t.id) into v_ids from public.teams t
  where t.room_id = p_room_id and t.id = any (p_team_ids);
  if v_ids is null or cardinality(v_ids) < 2
     or cardinality(v_ids) <> cardinality(array(select distinct unnest(p_team_ids))) then
    raise exception 'INVALID_TEAMS';
  end if;
  perform private.sync_settle(p_room_id);
  if exists (select 1 from public.sync_rounds where room_id = p_room_id and status = 'RUNNING') then
    raise exception 'GAME_IN_PROGRESS';
  end if;
  perform private.sync_new_round(p_room_id, 'READY', v_ids);
  update public.rooms set mode = 'SYNC', rev = rev + 1 where id = p_room_id returning * into v_room;
  return private.room_json(v_room);
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
  public.admin_sync_add_test_teams(text, uuid, integer),
  public.match_state(text),
  public.match_answer(text, uuid, text, bigint),
  public.match_public_state(text),
  public.admin_match_state(text, text),
  public.admin_match_action(text, uuid, uuid, integer, text),
  public.admin_match_setup(text, uuid, uuid, text, integer, jsonb),
  public.admin_match_edit_question(text, uuid, uuid, integer, jsonb),
  public.admin_match_set_standings(text, uuid, boolean),
  public.admin_match_sync_final(text, uuid, uuid, uuid[])
to anon, authenticated;

-- Realtime: game state changes (no answers or scores in this table)
alter publication supabase_realtime add table public.family_match_games;

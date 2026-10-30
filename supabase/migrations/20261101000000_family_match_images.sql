-- =====================================================================
-- FAMILY MATCH — a picture per question for the big screen
-- =====================================================================
-- Each question carries its own image_url, edited together with the
-- question text in the admin editor, so reordering questions moves their
-- pictures with them.
--   ''                          no picture
--   /match/<name>.jpg|jpeg|png|webp   a picture shipped with the app (public/match)
--   https://…                   any other web address
-- Quotes, brackets, spaces and backslashes are refused so the value is safe
-- inside an <img src> and a CSS url().
-- =====================================================================

alter table public.family_match_questions
  add column image_url text not null default ''
  check (char_length(image_url) <= 500
         and (image_url = ''
              or image_url ~ '^/match/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$'
              or image_url ~ '^https://[^\s"''()<>\\]+$'));

-- existing games get the built-in pictures by question number
update public.family_match_questions set image_url = '/match/q' || question_number || '.jpg' where image_url = '';

create or replace function private.match_image(p_url text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_url, ''));
begin
  if v = '' then return ''; end if;
  if char_length(v) > 500
     or not (v ~ '^/match/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$' or v ~ '^https://[^\s"''()<>\\]+$') then
    raise exception 'INVALID_IMAGE';
  end if;
  return v;
end $$;

create or replace function private.match_question_json(q public.family_match_questions)
returns jsonb language sql stable set search_path = '' as $$
  select case when q.id is null then null else jsonb_build_object(
    'id', q.id, 'question_number', q.question_number,
    'story_title', q.story_title, 'story_text', q.story_text, 'question_text', q.question_text,
    'option_a', q.option_a, 'option_b', q.option_b, 'duration_seconds', q.duration_seconds,
    'image_url', q.image_url,
    'status', q.status,
    'opened_ms', private.epoch_ms(q.opened_at),
    'closes_ms', private.epoch_ms(q.closes_at),
    'closed_ms', private.epoch_ms(q.closed_at)) end
$$;

-- The built-in storytelling set: "사라진 문화상품권 40장을 찾아라!" with its pictures
create or replace function private.match_default_template()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'title', '사라진 문화상품권 40장을 찾아라!',
    'question_count', 10,
    'show_standings', false,
    'questions', (
      select jsonb_agg(jsonb_build_object(
               'story_title', s, 'story_text', '', 'question_text', q,
               'option_a', a, 'option_b', b, 'duration_seconds', 15,
               'image_url', '/match/q' || n || '.jpg') order by n)
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

create or replace function private.match_template(g public.family_match_games)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'title', g.title, 'question_count', g.question_count, 'show_standings', g.show_standings,
    'questions', (select jsonb_agg(jsonb_build_object(
                    'story_title', q.story_title, 'story_text', q.story_text,
                    'question_text', q.question_text, 'option_a', q.option_a, 'option_b', q.option_b,
                    'duration_seconds', q.duration_seconds, 'image_url', q.image_url) order by q.question_number)
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
    (game_id, question_number, story_title, story_text, question_text, option_a, option_b, duration_seconds, image_url)
  select v_g.id, x.ord, x.e ->> 'story_title', coalesce(x.e ->> 'story_text', ''), x.e ->> 'question_text',
         x.e ->> 'option_a', x.e ->> 'option_b', coalesce((x.e ->> 'duration_seconds')::int, 15),
         coalesce(x.e ->> 'image_url', '')
  from jsonb_array_elements(v_t -> 'questions') with ordinality as x (e, ord);
  return v_g;
end $$;

-- Validates and stores one question of the editor. A request without
-- image_url (older admin screen) keeps the current picture.
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
         duration_seconds = v_duration,
         image_url = case when e ? 'image_url' then private.match_image(e ->> 'image_url') else image_url end
   where game_id = p_game_id and question_number = p_number;
  if not found then raise exception 'INVALID_QUESTIONS'; end if;
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;

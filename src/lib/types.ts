export type RoundStatus = 'WAITING' | 'READY' | 'ARMED' | 'LOCKED' | 'FINISHED';
export type RoomStatus = 'OPEN' | 'ENDED';
export type RoomMode = 'BUZZER' | 'SYNC' | 'MATCH' | 'OX';

export interface Room {
  id: string;
  room_code: string;
  status: RoomStatus;
  announcement: string | null;
  announcement_at: string | null;
  test_mode: boolean;
  rev: number;
  created_at: string;
  mode: RoomMode;
  sync_show_progress: boolean;
}

export interface Round {
  id: string;
  room_id: string;
  round_number: number;
  status: RoundStatus;
  arm_seq: number;
  armed_at: string | null;
  winner_id: string | null;
  winner_nickname: string | null;
  winner_at: string | null;
  created_at: string;
}

export interface ParticipantSync {
  ok: true;
  participant: { id: string; nickname: string };
  room: Room;
  round: Round | null;
  me: { attempted: boolean; excluded: boolean; wins: number };
  participant_count: number;
  server_time: string;
}

export type SyncFailure = { ok: false; error: 'INVALID_TOKEN' | 'KICKED' };

export type BuzzResult =
  | 'WON' | 'LOST' | 'LOCKED' | 'NOT_ARMED' | 'STALE_ROUND' | 'EXCLUDED' | 'INVALID_TOKEN' | 'KICKED';

export interface BuzzResponse {
  ok: boolean;
  result: BuzzResult;
  duplicate?: boolean;
  round_id?: string;
  winner_nickname?: string | null;
  winner_at?: string | null;
}

export interface AdminParticipant {
  id: string;
  nickname: string;
  is_active: boolean;
  is_test: boolean;
  joined_at: string;
  last_seen_at: string;
  online: boolean;
  wins: number;
}

export interface Attempt {
  nickname: string;
  received_at: string;
  arm_seq: number;
  accepted: boolean;
  revoked: boolean;
}

export interface AdminState {
  room: Room;
  round: Round | null;
  participants: AdminParticipant[];
  rounds: Round[];
  attempts: Attempt[];
  server_time: string;
}

export interface PublicState {
  room: Room;
  round: Round | null;
  participant_count: number;
  recent_winners: Array<{ round_number: number; winner_nickname: string }>;
  server_time: string;
}

export interface ParticipantSession {
  token: string;
  participant_id: string;
  nickname: string;
  room_code: string;
}

// ---------------------------------------------------------------------------
// FAMILY SYNC MODE

export type SyncStatus = 'WAITING' | 'READY' | 'RUNNING' | 'FINISHED' | 'RESULTS';

export interface SyncRound {
  id: string;
  room_id: string;
  round_number: number;
  status: SyncStatus;
  started_at: string | null;
  ended_at: string | null;
  /** scheduled GO instant, server clock (epoch ms) */
  started_ms: number | null;
  /** last instant a press is accepted, server clock (epoch ms) */
  deadline_ms: number | null;
  duration_ms: number;
  lead_ms: number;
  /** rematch: only these teams play */
  team_ids: string[] | null;
  /** ranks >= this (and every rank > 5) are public; 1 = all; null = none */
  revealed_rank: number | null;
  created_at: string;
}

export interface SyncMemberResult {
  participant_id: string;
  label: string;
  elapsed_ms: number | null;
}

export interface SyncTeamResult {
  team_id: string;
  team_name: string;
  status: 'COMPLETE' | 'PARTIAL' | 'NONE';
  gap_ms: number | null;
  rank: number | null;
  members: SyncMemberResult[];
}

export interface SyncProgress {
  pressed: number;
  expected: number;
}

export interface SyncParticipantState {
  ok: true;
  participant: { id: string; label: string };
  team: {
    id: string;
    name: string;
    members: Array<{ participant_id: string; label: string; me: boolean; online: boolean }>;
  };
  room: Room;
  round: SyncRound | null;
  me: { pressed: boolean; eligible: boolean };
  results: SyncTeamResult[];
  team_count: number;
  server_now_ms: number;
}

export interface SyncAdminTeam {
  team_id: string;
  team_name: string;
  members: Array<{
    participant_id: string;
    label: string;
    slot: number;
    is_test: boolean;
    online: boolean;
    elapsed_ms: number | null;
  }>;
}

export interface SyncAdminState {
  room: Room;
  round: SyncRound | null;
  teams: SyncAdminTeam[];
  results: SyncTeamResult[];
  progress: SyncProgress;
  rounds: Array<SyncRound & { winners: SyncTeamResult[] }>;
  server_now_ms: number;
}

export interface SyncPublicState {
  room: Room;
  round: SyncRound | null;
  teams: Array<{ team_name: string; members: number }>;
  progress: SyncProgress | null;
  results: SyncTeamResult[];
  server_now_ms: number;
}

export type SyncBuzzResult =
  | 'ACCEPTED' | 'DUPLICATE' | 'TOO_EARLY' | 'TOO_LATE' | 'CLOSED' | 'NOT_STARTED'
  | 'NOT_ELIGIBLE' | 'TEAM_DONE' | 'STALE_ROUND' | 'INVALID_TOKEN' | 'KICKED';

export interface SyncBuzzResponse {
  ok: boolean;
  result: SyncBuzzResult;
  round_id?: string;
  wait_ms?: number;
}

export interface SyncSession {
  token: string;
  participant_id: string;
  team_id: string;
  team_name: string;
  label: string;
  room_code: string;
}

// ---------------------------------------------------------------------------
// FAMILY MATCH MODE (우리 가족 이구동성)

export type MatchGameStatus =
  | 'LOBBY' | 'QUESTION_READY' | 'QUESTION_OPEN' | 'QUESTION_CLOSED' | 'RESULT_REVEAL' | 'GAME_FINISHED';
export type MatchQuestionStatus = 'PENDING' | 'READY' | 'OPEN' | 'CLOSED' | 'REVEALED';
export type MatchOption = 'A' | 'B';

export interface MatchGame {
  id: string;
  room_id: string;
  game_number: number;
  title: string;
  status: MatchGameStatus;
  question_count: number;
  /** 0 = lobby */
  current_question: number;
  /** denominator of the final match rate (set when the game finishes) */
  total_questions: number | null;
  show_standings: boolean;
  /** final ranks >= this (and every rank > 3) are public; 1 = all; null = none */
  final_revealed_rank: number | null;
  rev: number;
  created_at: string;
  finished_at: string | null;
}

export interface MatchQuestion {
  id: string;
  question_number: number;
  story_title: string;
  story_text: string;
  question_text: string;
  option_a: string;
  option_b: string;
  duration_seconds: number;
  /** picture on the big screen: '' (none), /match/… (shipped) or https://… */
  image_url: string;
  status: MatchQuestionStatus;
  /** server clock (epoch ms) */
  opened_ms: number | null;
  closes_ms: number | null;
  closed_ms: number | null;
}

/** editable part of a question */
export type MatchQuestionDraft = Pick<MatchQuestion, 'story_title' | 'story_text' | 'question_text' | 'option_a' | 'option_b' | 'duration_seconds' | 'image_url'>;

export interface MatchVerdict {
  team_id: string;
  team_name: string;
  label_1: string | null;
  option_1: MatchOption | null;
  label_2: string | null;
  option_2: MatchOption | null;
  matched: boolean;
  points: 0 | 1;
  /** running total up to this question */
  total: number;
}

export interface MatchStanding {
  team_id: string;
  team_name: string;
  score: number;
  played: number;
  rank: number;
}

export interface MatchFinalRow {
  team_id: string;
  team_name: string;
  matched_count: number;
  total_questions: number;
  match_percentage: number;
  rank: number;
}

export interface MatchProgress {
  answered_teams: number;
  answered_people: number;
  team_count: number;
}

export interface MatchParticipantState {
  ok: true;
  participant: { id: string; label: string };
  team: SyncParticipantState['team'];
  room: Room;
  game: MatchGame | null;
  question: MatchQuestion | null;
  me: { answer: MatchOption | null; seq: number | null };
  reveal: {
    mine: MatchOption | null;
    partner: { label: string; option: MatchOption } | null;
    matched: boolean;
    points: number;
  } | null;
  /** points of revealed questions */
  score: number;
  final: MatchFinalRow[];
  team_count: number;
  server_now_ms: number;
}

export interface MatchAdminTeam {
  team_id: string;
  team_name: string;
  /** answers to the current question (0..2) */
  answered: number;
  members: Array<{
    participant_id: string;
    label: string;
    slot: number;
    is_test: boolean;
    online: boolean;
    answered: boolean;
  }>;
}

export interface MatchGameSummary {
  id: string;
  game_number: number;
  title: string;
  status: MatchGameStatus;
  question_count: number;
  current_question: number;
  total_questions: number | null;
  finished_at: string | null;
  winners: string[];
}

export interface MatchAdminState {
  room: Room;
  game: MatchGame | null;
  question: MatchQuestion | null;
  questions: MatchQuestion[];
  teams: MatchAdminTeam[];
  progress: MatchProgress;
  results: MatchVerdict[];
  standings: MatchStanding[];
  final: MatchFinalRow[];
  games: MatchGameSummary[];
  server_now_ms: number;
}

export interface MatchPublicState {
  room: Room;
  game: MatchGame | null;
  question: MatchQuestion | null;
  teams: Array<{ team_name: string; members: number }>;
  progress: MatchProgress | null;
  results: MatchVerdict[];
  standings: MatchStanding[];
  final: MatchFinalRow[];
  server_now_ms: number;
}

export type MatchAnswerResult =
  | 'ACCEPTED' | 'STALE' | 'NOT_OPEN' | 'TOO_LATE' | 'CLOSED' | 'STALE_QUESTION' | 'INVALID_OPTION'
  | 'INVALID_TOKEN' | 'KICKED';

export interface MatchAnswerResponse {
  ok: boolean;
  result: MatchAnswerResult;
  question_id?: string;
  /** the answer stored on the server after this request */
  option?: MatchOption | null;
}

// ---------------------------------------------------------------------------
// OX SURVIVAL MODE (questions are read aloud; only answers are stored)

export type OxGameStatus =
  | 'LOBBY' | 'ROUND_READY' | 'ANSWERING' | 'ANSWER_CLOSED' | 'RESULT_REVEALED' | 'ROUND_VOID' | 'FINISHED';
export type OxRoundStatus = 'READY' | 'ANSWERING' | 'CLOSED' | 'REVEALED' | 'VOID';
export type OxAnswer = 'O' | 'X';
export type OxResult = 'CHAMPION' | 'CO_WINNERS' | 'ENDED';
export type OxSurvival = 'ALIVE' | 'ELIMINATED';

export interface OxGame {
  id: string;
  room_id: string;
  game_number: number;
  status: OxGameStatus;
  current_round: number;
  current_round_id: string | null;
  time_limit_seconds: number;
  initial_participant_count: number | null;
  result: OxResult | null;
  rev: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface OxRound {
  id: string;
  seq: number;
  round_number: number;
  status: OxRoundStatus;
  duration_seconds: number | null;
  /** the host stored an answer (the answer itself only for the host / after the reveal) */
  answer_set: boolean;
  correct_answer: OxAnswer | null;
  started_ms: number | null;
  deadline_ms: number | null;
  closed_ms: number | null;
  revealed_ms: number | null;
  survivors_before: number | null;
  survivors_after: number | null;
  correct_count: number | null;
  o_count: number | null;
  x_count: number | null;
}

export interface OxCounts {
  initial: number | null;
  alive: number;
  eliminated: number;
  answered: number;
  /** host only */
  o: number | null;
  x: number | null;
  /** lobby: participants START would register */
  candidates: number | null;
}

export type OxRole = 'CANDIDATE' | 'PLAYER' | 'SPECTATOR';

export interface OxParticipantState {
  ok: true;
  me: {
    participant_id: string;
    name: string;
    role: OxRole;
    status: OxSurvival | null;
    eliminated_round: number | null;
    answer: OxAnswer | null;
    seq: number | null;
    rank: number | null;
  };
  /** my verdict in the current round, once revealed */
  verdict: { selected: OxAnswer | null; correct: boolean } | null;
  room: Room;
  game: OxGame | null;
  round: OxRound | null;
  counts: OxCounts;
  winners: string[];
  server_now_ms: number;
}

export type OxAnswerResult =
  | 'ACCEPTED' | 'STALE' | 'NOT_OPEN' | 'TOO_LATE' | 'CLOSED' | 'STALE_ROUND' | 'NOT_PLAYING' | 'ELIMINATED'
  | 'INVALID_ANSWER' | 'INVALID_TOKEN' | 'KICKED';

export interface OxAnswerResponse {
  ok: boolean;
  result: OxAnswerResult;
  round_id?: string;
  /** the answer stored on the server after this request */
  answer?: OxAnswer | null;
}

export interface OxPublicState {
  room: Room;
  game: OxGame | null;
  round: OxRound | null;
  counts: OxCounts;
  survivors: string[];
  lobby: string[];
  winners: string[];
  server_now_ms: number;
}

export interface OxAdminPlayer {
  participant_id: string;
  name: string;
  status: OxSurvival;
  eliminated_round: number | null;
  is_test: boolean;
  online: boolean;
  answered: boolean;
  selected: OxAnswer | null;
}

export interface OxVerdict {
  participant_id: string;
  name: string;
  selected: OxAnswer | null;
  correct: boolean;
}

export interface OxRankRow {
  participant_id: string;
  name: string;
  status: OxSurvival;
  eliminated_round: number | null;
  rank: number;
}

export interface OxAdminState {
  room: Room;
  game: OxGame | null;
  round: OxRound | null;
  counts: OxCounts;
  candidates: Array<{ participant_id: string; name: string; kind: 'BUZZER' | 'SYNC'; is_test: boolean; online: boolean }>;
  players: OxAdminPlayer[];
  verdicts: OxVerdict[];
  rounds: Array<OxRound & { eliminated_names: string[] }>;
  ranking: OxRankRow[];
  games: Array<{
    id: string; game_number: number; status: OxGameStatus; current_round: number;
    initial_participant_count: number | null; result: OxResult | null; finished_at: string | null; winners: string[];
  }>;
  server_now_ms: number;
}

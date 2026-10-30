export type RoundStatus = 'WAITING' | 'READY' | 'ARMED' | 'LOCKED' | 'FINISHED';
export type RoomStatus = 'OPEN' | 'ENDED';
export type RoomMode = 'BUZZER' | 'SYNC' | 'MATCH';

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
  status: MatchQuestionStatus;
  /** server clock (epoch ms) */
  opened_ms: number | null;
  closes_ms: number | null;
  closed_ms: number | null;
}

/** editable part of a question */
export type MatchQuestionDraft = Pick<MatchQuestion, 'story_title' | 'story_text' | 'question_text' | 'option_a' | 'option_b' | 'duration_seconds'>;

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

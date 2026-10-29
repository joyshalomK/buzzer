export type RoundStatus = 'WAITING' | 'READY' | 'ARMED' | 'LOCKED' | 'FINISHED';
export type RoomStatus = 'OPEN' | 'ENDED';
export type RoomMode = 'BUZZER' | 'SYNC';

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

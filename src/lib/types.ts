export type RoundStatus = 'WAITING' | 'READY' | 'ARMED' | 'LOCKED' | 'FINISHED';
export type RoomStatus = 'OPEN' | 'ENDED';

export interface Room {
  id: string;
  room_code: string;
  status: RoomStatus;
  announcement: string | null;
  announcement_at: string | null;
  test_mode: boolean;
  rev: number;
  created_at: string;
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

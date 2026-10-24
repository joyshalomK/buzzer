import { describe, expect, it } from 'vitest';
import { clampNickname, deriveParticipantView, nicknameLength, pressKey, type ViewInput } from '../../src/lib/participantView';
import type { Room, Round } from '../../src/lib/types';

const room: Room = {
  id: 'room', room_code: 'ABCD', status: 'OPEN', announcement: null, announcement_at: null,
  test_mode: false, rev: 0, created_at: '',
};
const round = (o: Partial<Round> = {}): Round => ({
  id: 'r1', room_id: 'room', round_number: 1, status: 'WAITING', arm_seq: 0, armed_at: null,
  winner_id: null, winner_nickname: null, winner_at: null, created_at: '', ...o,
});
const input = (o: Partial<ViewInput> = {}): ViewInput => ({
  connected: true, room, round: round(), myId: 'me', attempted: false, excluded: false, localPressKey: null, ...o,
});

describe('deriveParticipantView', () => {
  it('WAITING / READY are not pressable', () => {
    expect(deriveParticipantView(input())).toMatchObject({ kind: 'WAITING', canBuzz: false, message: '사회자가 준비 중입니다' });
    expect(deriveParticipantView(input({ round: round({ status: 'READY' }) }))).toMatchObject({ kind: 'READY', canBuzz: false, message: '곧 시작합니다' });
  });

  it('ARMED is pressable exactly once per arming', () => {
    const armed = round({ status: 'ARMED', arm_seq: 1 });
    expect(deriveParticipantView(input({ round: armed }))).toMatchObject({ kind: 'ARMED', canBuzz: true, title: '지금 누르세요!' });
    expect(deriveParticipantView(input({ round: armed, localPressKey: pressKey(armed) })).canBuzz).toBe(false);
    expect(deriveParticipantView(input({ round: armed, attempted: true })).kind).toBe('PRESSED');
    // after a re-arm the old local press no longer blocks
    const rearmed = round({ status: 'ARMED', arm_seq: 2 });
    expect(deriveParticipantView(input({ round: rearmed, localPressKey: pressKey(armed) })).canBuzz).toBe(true);
  });

  it('excluded (cancelled winner) cannot press', () => {
    expect(deriveParticipantView(input({ round: round({ status: 'ARMED' }), excluded: true }))).toMatchObject({ kind: 'EXCLUDED', canBuzz: false });
  });

  it('winner screens use only server-confirmed winner fields', () => {
    const won = round({ status: 'LOCKED', winner_id: 'me', winner_nickname: '민수', winner_at: 'x' });
    expect(deriveParticipantView(input({ round: won }))).toMatchObject({ kind: 'WINNER_ME', title: '1등! 민수', canBuzz: false });
    const lost = round({ status: 'LOCKED', winner_id: 'other', winner_nickname: '지우', winner_at: 'x' });
    expect(deriveParticipantView(input({ round: lost }))).toMatchObject({ kind: 'WINNER_OTHER', message: '지우님이 먼저 눌렀습니다' });
    // a local press alone never shows a win
    const armed = round({ status: 'ARMED' });
    expect(deriveParticipantView(input({ round: armed, localPressKey: pressKey(armed) })).kind).toBe('PRESSED');
  });

  it('disconnected disables the buzzer even when armed', () => {
    expect(deriveParticipantView(input({ connected: false, round: round({ status: 'ARMED' }) }))).toMatchObject({
      kind: 'DISCONNECTED', canBuzz: false, message: '연결이 끊어졌습니다. 재연결 중입니다',
    });
  });

  it('locked without winner, ended room, loading', () => {
    expect(deriveParticipantView(input({ round: round({ status: 'LOCKED' }) })).kind).toBe('LOCKED');
    expect(deriveParticipantView(input({ room: { ...room, status: 'ENDED' } })).kind).toBe('ENDED');
    expect(deriveParticipantView(input({ room: null })).kind).toBe('LOADING');
    expect(deriveParticipantView(input({ round: null })).kind).toBe('WAITING');
  });
});

describe('nickname helpers', () => {
  it('counts code points like Postgres char_length', () => {
    expect(nicknameLength('민수')).toBe(2);
    expect(nicknameLength('😀😀')).toBe(2);
    expect(clampNickname('가나다라마바사아자차카타파하')).toBe('가나다라마바사아자차카타');
    expect(clampNickname('😀'.repeat(20))).toHaveLength(24); // 12 emoji = 24 UTF-16 units
  });
});

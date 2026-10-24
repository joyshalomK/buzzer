import { describe, expect, it } from 'vitest';
import { roundsToCsv } from '../../src/lib/csv';
import type { Round } from '../../src/lib/types';

const r = (n: number, name: string | null): Round => ({
  id: `r${n}`, room_id: 'x', round_number: n, status: 'FINISHED', arm_seq: 1,
  armed_at: '2026-12-20T10:00:00.000Z', winner_id: null, winner_nickname: name,
  winner_at: name ? '2026-12-20T10:00:01.250Z' : null, created_at: '',
});

describe('roundsToCsv', () => {
  it('sorts by round, includes BOM, reaction time and escapes', () => {
    const csv = roundsToCsv([r(2, '=HYPERLINK("x")'), r(1, '민수')]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toContain('라운드');
    expect(lines[1]).toMatch(/^"1","민수",".*","1\.250","FINISHED"$/);
    // formula injection neutralised and quotes doubled
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

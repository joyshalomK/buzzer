import type { MatchFinalRow, MatchVerdict, Round, SyncTeamResult } from './types';

function cell(v: unknown) {
  const s = v == null ? '' : String(v);
  // quote, and neutralise spreadsheet formula injection (=, +, -, @)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function roundsToCsv(rounds: Round[]) {
  const header = ['라운드', '우승자', '우승 시각', '반응 시간(초)', '상태'];
  const rows = [...rounds]
    .sort((a, b) => a.round_number - b.round_number)
    .map((r) => {
      const reaction = r.winner_at && r.armed_at ? ((Date.parse(r.winner_at) - Date.parse(r.armed_at)) / 1000).toFixed(3) : '';
      return [r.round_number, r.winner_nickname ?? '', r.winner_at ? new Date(r.winner_at).toLocaleString('ko-KR') : '', reaction, r.status];
    });
  // BOM so Excel opens Korean text correctly
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

const SYNC_STATUS: Record<SyncTeamResult['status'], string> = { COMPLETE: '완료', PARTIAL: '미완료', NONE: '미참여' };

/** FAMILY SYNC results of one round. Times are server-receipt based (see README). */
export function syncResultsToCsv(roundNumber: number, results: SyncTeamResult[]) {
  const header = ['라운드', '순위', '가족 닉네임', '참가자1', '기록1(ms)', '참가자2', '기록2(ms)', '시간 차이(ms)', '상태'];
  const rows = results.map((t) => [
    roundNumber, t.rank ?? '', t.team_name,
    t.members[0]?.label ?? '', t.members[0]?.elapsed_ms ?? '',
    t.members[1]?.label ?? '', t.members[1]?.elapsed_ms ?? '',
    t.gap_ms ?? '', SYNC_STATUS[t.status],
  ]);
  return '\uFEFF' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

/** FAMILY MATCH final ranking. */
export function matchFinalToCsv(gameNumber: number, final: MatchFinalRow[]) {
  const header = ['게임', '순위', '가족팀', '일치 문항 수', '전체 문항 수', '일치율(%)'];
  const rows = final.map((t) => [gameNumber, t.rank, t.team_name, t.matched_count, t.total_questions, t.match_percentage]);
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

/** FAMILY MATCH verdicts of one question. */
export function matchVerdictsToCsv(questionNumber: number, verdicts: MatchVerdict[]) {
  const header = ['문항', '가족팀', '참가자1', '선택1', '참가자2', '선택2', '일치', '점수', '누적 점수'];
  const rows = verdicts.map((v) => [
    questionNumber, v.team_name, v.label_1 ?? '', v.option_1 ?? '미응답', v.label_2 ?? '', v.option_2 ?? '미응답',
    v.matched ? 'O' : 'X', v.points, v.total,
  ]);
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

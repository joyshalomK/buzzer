import type { Round } from './types';

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

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

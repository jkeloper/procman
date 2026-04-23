import { describe, it, expect } from 'vitest';
import { mergeLines } from '../useLogStream';
import type { LogLine } from '@/api/tauri';

function line(seq: number, text = `line ${seq}`): LogLine {
  return { seq, ts_ms: seq, stream: 'stdout', text };
}

describe('mergeLines', () => {
  it('appends monotonically increasing seqs', () => {
    const prev = [line(0), line(1)];
    const incoming = [line(2), line(3)];
    const merged = mergeLines(prev, incoming);
    expect(merged.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
  });

  it('deduplicates overlapping seqs', () => {
    const prev = [line(0), line(1), line(2)];
    const incoming = [line(1), line(2), line(3)];
    const merged = mergeLines(prev, incoming);
    expect(merged.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
  });

  it('drops prev when incoming seq rewinds (restart)', () => {
    const prev = [line(10, 'old a'), line(11, 'old b'), line(12, 'old c')];
    const incoming = [line(0, 'new a'), line(1, 'new b')];
    const merged = mergeLines(prev, incoming);
    expect(merged.map((l) => l.seq)).toEqual([0, 1]);
    expect(merged.map((l) => l.text)).toEqual(['new a', 'new b']);
  });

  it('does not drop prev when incoming overlaps but stays above', () => {
    const prev = [line(5), line(6)];
    const incoming = [line(6), line(7)];
    const merged = mergeLines(prev, incoming);
    expect(merged.map((l) => l.seq)).toEqual([5, 6, 7]);
  });

  it('handles empty prev', () => {
    const merged = mergeLines([], [line(0), line(1)]);
    expect(merged.map((l) => l.seq)).toEqual([0, 1]);
  });

  it('handles empty incoming (no-op)', () => {
    const prev = [line(0), line(1)];
    const merged = mergeLines(prev, []);
    expect(merged).toBe(prev);
  });
});

import { useCallback, useEffect, useState } from 'react';
import type { AskKind } from './signals';

/**
 * What the week dial and "scams stopped" are made of. Kept in this browser only (like the app,
 * which keeps call history on the phone): nothing here leaves the device.
 */
export type CheckSource = 'mic' | 'call' | 'text';
export type Outcome = 'open' | 'hung_up' | 'kept';

export interface HistoryRecord {
  id: string;
  at: number;
  type: 'check' | 'warning';
  source: CheckSource;
  kind?: AskKind;
  outcome?: Outcome;
  /** Seconds from the ask to the end of the call. */
  secondsToEnd?: number;
}

export interface DayTally {
  startMs: number;
  checks: number;
  warnings: number;
  stopped: number;
  latestWarning: HistoryRecord | null;
}

const KEY = 'edgerunners_history';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function load(): HistoryRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((r) => Date.now() - r.at < WEEK_MS) : [];
  } catch {
    return [];
  }
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The last seven days, oldest first; the last entry is today. */
export function weekOf(records: HistoryRecord[], nowMs: number): DayTally[] {
  const today = startOfDay(nowMs);
  return Array.from({ length: 7 }, (_, i) => {
    const start = new Date(today);
    start.setDate(start.getDate() - (6 - i));
    const startMs = start.getTime();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const day = records.filter((r) => r.at >= startMs && r.at < end.getTime());
    const warnings = day.filter((r) => r.type === 'warning');
    return {
      startMs,
      checks: day.filter((r) => r.type === 'check').length,
      warnings: warnings.length,
      stopped: warnings.filter((r) => r.outcome === 'hung_up').length,
      latestWarning: warnings.length ? warnings[warnings.length - 1] : null,
    };
  });
}

export function useHistory() {
  const [records, setRecords] = useState<HistoryRecord[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(records));
    } catch {
      // Private window or blocked storage: the dial still works for this visit.
    }
  }, [records]);

  const addCheck = useCallback((source: CheckSource) => {
    setRecords((prev) => [...prev, { id: newId(), at: Date.now(), type: 'check', source }]);
  }, []);

  const openWarning = useCallback((source: CheckSource, kind: AskKind) => {
    const id = newId();
    setRecords((prev) => [...prev, { id, at: Date.now(), type: 'warning', source, kind, outcome: 'open' }]);
    return id;
  }, []);

  const resolveWarning = useCallback((id: string, outcome: Exclude<Outcome, 'open'>) => {
    setRecords((prev) =>
      prev.map((r) =>
        r.id === id && r.outcome === 'open'
          ? { ...r, outcome, secondsToEnd: Math.max(1, Math.round((Date.now() - r.at) / 1000)) }
          : r
      )
    );
  }, []);

  const clear = useCallback(() => setRecords([]), []);

  return { records, addCheck, openWarning, resolveWarning, clear };
}

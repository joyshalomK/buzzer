import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { RpcError, supabase } from '../lib/supabase';
import type { MatchGame, Room, Round, SyncRound } from '../lib/types';

export type RealtimeStatus = 'connecting' | 'live' | 'down';
export type LiveTable = 'rooms' | 'rounds' | 'sync_rounds' | 'family_match_games';

const DEFAULT_TABLES: LiveTable[] = ['rooms', 'rounds', 'sync_rounds'];

export interface LiveSyncOptions<T> {
  /** room uuid to subscribe to; null = don't subscribe yet */
  roomId: string | null;
  /** fetches authoritative state from the server */
  fetcher: () => Promise<T>;
  /** called for every realtime row change (before the debounced re-fetch) */
  onChange?: (change: RealtimePostgresChangesPayload<Room | Round | SyncRound | MatchGame>, table: LiveTable) => void;
  /** tables to subscribe to (all filtered to this room) */
  tables?: LiveTable[];
  /** re-fetch period while realtime is healthy (safety net) */
  liveIntervalMs?: number;
  /** re-fetch period while realtime is down (polling fallback) */
  pollIntervalMs?: number;
  enabled?: boolean;
}

export interface LiveSync<T> {
  data: T | null;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
  realtime: RealtimeStatus;
  /** true when the server answered recently */
  connected: boolean;
  error: unknown;
  refresh: () => Promise<void>;
}

const STALE_AFTER_MS = 20_000;

/**
 * Keeps local state in sync with the server:
 *  - Supabase Realtime postgres_changes on the room's tables for instant updates
 *  - every change triggers a re-fetch so the UI always ends on server truth
 *  - periodic re-fetch (fast polling if realtime is down, slow otherwise)
 *  - re-subscribe with backoff, and re-sync on tab focus / network change
 */
export function useLiveSync<T>({
  roomId,
  fetcher,
  onChange,
  liveIntervalMs = 8000,
  pollIntervalMs = 2000,
  enabled = true,
  tables = DEFAULT_TABLES,
}: LiveSyncOptions<T>): LiveSync<T> {
  const [data, setData] = useState<T | null>(null);
  const [realtime, setRealtime] = useState<RealtimeStatus>('connecting');
  const [error, setError] = useState<unknown>(null);
  const [lastOkAt, setLastOkAt] = useState(0);
  const [failures, setFailures] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [now, setNow] = useState(() => Date.now());
  const [channelGen, setChannelGen] = useState(0);
  const tableKey = tables.join(',');

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const inflight = useRef<Promise<void> | null>(null);
  const rerun = useRef(false);
  const lastFetchAt = useRef(0);
  const debounce = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      rerun.current = true;
      return inflight.current;
    }
    const run = async () => {
      do {
        rerun.current = false;
        lastFetchAt.current = Date.now();
        try {
          const next = await fetcherRef.current();
          setData(next);
          setError(null);
          setFailures(0);
          setLastOkAt(Date.now());
        } catch (e) {
          setError(e);
          if (!(e instanceof RpcError) || e.network) setFailures((f) => f + 1);
          else setLastOkAt(Date.now()); // the server answered, just with an error
        }
      } while (rerun.current);
    };
    inflight.current = run().finally(() => {
      inflight.current = null;
    });
    return inflight.current;
  }, []);

  const scheduleRefresh = useCallback(
    (delay = 120) => {
      window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => void refresh(), delay);
    },
    [refresh],
  );

  // initial load
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh, roomId]);

  // realtime channel (recreated on failure via channelGen)
  useEffect(() => {
    if (!enabled || !roomId) return;
    let retryTimer: number | undefined;
    let disposed = false;
    setRealtime('connecting');

    let channel: RealtimeChannel = supabase.channel(`room-${roomId}-${channelGen}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of tableKey.split(',') as LiveTable[]) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: table === 'rooms' ? `id=eq.${roomId}` : `room_id=eq.${roomId}` },
        (p) => {
          onChangeRef.current?.(p as RealtimePostgresChangesPayload<Room | Round | SyncRound | MatchGame>, table);
          // spread participant re-syncs out a little when 20 phones get the same room event
          scheduleRefresh(table === 'rooms' ? 150 + Math.random() * 600 : 120);
        },
      );
    }
    channel
      .subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          setRealtime('live');
          void refresh(); // catch anything missed while (re)connecting
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtime('down');
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(() => setChannelGen((g) => g + 1), 3000 + Math.random() * 2000);
        }
      });

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      void supabase.removeChannel(channel);
    };
  }, [enabled, roomId, channelGen, tableKey, refresh, scheduleRefresh]);

  // periodic re-fetch: safety net when live, polling fallback when down
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const backoff = Math.min(failures, 3) * 1000;
      const base = realtime === 'live' ? liveIntervalMs : pollIntervalMs + backoff;
      // background tabs keep syncing, just slower (a covered projector window must not freeze)
      const period = document.visibilityState === 'visible' ? base : base * 3;
      if (t - lastFetchAt.current >= period) void refresh();
    }, 1000);
    return () => window.clearInterval(id);
  }, [enabled, realtime, failures, liveIntervalMs, pollIntervalMs, refresh]);

  // screen wake / tab focus / network switch (Wi-Fi <-> LTE)
  useEffect(() => {
    if (!enabled) return;
    const resync = () => {
      void refresh();
      if (realtime !== 'live') setChannelGen((g) => g + 1);
    };
    const onVisible = () => document.visibilityState === 'visible' && resync();
    const onOnline = () => {
      setOnline(true);
      resync();
    };
    const onOffline = () => setOnline(false);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', resync);
    window.addEventListener('pageshow', resync);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', resync);
      window.removeEventListener('pageshow', resync);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, realtime, refresh]);

  useEffect(() => () => window.clearTimeout(debounce.current), []);

  const connected = online && lastOkAt > 0 && failures < 2 && now - lastOkAt < STALE_AFTER_MS;

  return { data, setData, realtime, connected, error, refresh };
}

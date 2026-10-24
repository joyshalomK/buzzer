// localStorage can throw (private mode, blocked storage) — never let it crash the app.
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const KEYS = {
  session: 'fmquiz.session',
  admin: 'fmquiz.admin',
  adminRoom: 'fmquiz.admin.room',
  muted: 'fmquiz.muted',
} as const;

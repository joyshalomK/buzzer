import pg from 'pg';
import { inject } from 'vitest';

export const ADMIN_PASSWORD = 'test-admin-password!';

/** Superuser pool — only used to set up fixtures and inspect internals. */
export function superPool() {
  return new pg.Pool({ connectionString: inject('dbUrl'), max: 5 });
}

/**
 * Pool whose every connection runs as the `anon` role, i.e. exactly the
 * privileges a browser with the Supabase anon key gets through PostgREST.
 */
export function anonPool(max = 40) {
  return new pg.Pool({ connectionString: inject('dbUrl'), max, options: '-c role=anon' });
}

type Queryable = pg.Pool | pg.PoolClient | pg.Client;

/** Calls an RPC with named arguments the same way PostgREST does. */
export async function rpc<T = any>(db: Queryable, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args);
  const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const res = await db.query(`select public.${fn}(${params}) as r`, keys.map((k) => args[k]));
  return res.rows[0].r as T;
}

/** Expects an RPC to raise; returns the error message. */
export async function rpcError(db: Queryable, fn: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    await rpc(db, fn, args);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`expected ${fn} to fail`);
}

export async function setupAdmin(su: pg.Pool, anon: pg.Pool) {
  await su.query('select private.set_admin_password($1)', [ADMIN_PASSWORD]);
  await su.query('truncate private.admin_login_attempts');
  const login = await rpc(anon, 'admin_login', { p_password: ADMIN_PASSWORD });
  if (!login.ok) throw new Error('admin login failed: ' + JSON.stringify(login));
  return login.token as string;
}

export async function createRoom(anon: pg.Pool, admin: string) {
  const room = await rpc(anon, 'admin_create_room', { p_admin_token: admin });
  return room as { id: string; room_code: string };
}

export async function currentRound(anon: pg.Pool, admin: string, roomCode: string) {
  const s = await rpc(anon, 'admin_get_state', { p_admin_token: admin, p_room_code: roomCode });
  return s.round as { id: string; status: string; round_number: number; arm_seq: number; winner_nickname: string | null };
}

export async function action(anon: pg.Pool, admin: string, roomId: string, roundId: string, act: string) {
  return rpc(anon, 'admin_round_action', {
    p_admin_token: admin, p_room_id: roomId, p_round_id: roundId, p_action: act,
  });
}

export async function joinMany(anon: pg.Pool, roomCode: string, n: number, prefix = 'p') {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      rpc(anon, 'join_room', { p_room_code: roomCode, p_nickname: `${prefix}${i + 1}` }),
    ),
  ) as Promise<Array<{ participant_id: string; token: string; nickname: string }>>;
}

/** Opens `n` dedicated anon connections (one per simulated phone). */
export async function phones(n: number) {
  const clients: pg.Client[] = [];
  for (let i = 0; i < n; i++) {
    const c = new pg.Client({ connectionString: inject('dbUrl'), options: '-c role=anon' });
    await c.connect();
    clients.push(c);
  }
  return { clients, close: () => Promise.all(clients.map((c) => c.end())) };
}

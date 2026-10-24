// Local rehearsal backend — NOT for production.
// Runs a real PostgreSQL (embedded-postgres) with the production migration and
// exposes the PostgREST-compatible endpoint POST /rest/v1/rpc/<fn> that
// supabase-js uses. There is no Realtime server, so the app runs in its
// polling-fallback mode — handy for testing that path too.
//
//   npm run local:backend            (admin password: localadmin123)
//   npm run dev:local                (phones on the same Wi-Fi can use the Network URL)
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const HTTP_PORT = Number(process.env.PORT ?? 54321);
const PG_PORT = 54400 + Math.floor(Math.random() * 400);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'localadmin123';

const dir = mkdtempSync(join(tmpdir(), 'buzzer-local-'));
const server = new EmbeddedPostgres({
  databaseDir: dir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false, onLog: () => {},
});
await server.initialise();
await server.start();
await server.createDatabase('buzzer');
const url = `postgres://postgres:postgres@localhost:${PG_PORT}/buzzer`;

const setup = new pg.Client({ connectionString: url });
await setup.connect();
await setup.query(`create role anon nologin; create role authenticated nologin; create schema extensions;
  grant usage on schema public, extensions to anon, authenticated;`);
const migrations = join(process.cwd(), 'supabase', 'migrations');
for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
  await setup.query(readFileSync(join(migrations, f), 'utf8'));
}
await setup.query('select private.set_admin_password($1)', [ADMIN_PASSWORD]);
await setup.end();

// every API request runs as `anon`, exactly like PostgREST with the anon key
const pool = new pg.Pool({ connectionString: url, max: 50, options: '-c role=anon' });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const m = req.url?.match(/^\/rest\/v1\/rpc\/([a-z_]+)/);
  if (req.method !== 'POST' || !m) return res.writeHead(404, cors).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const args = body ? JSON.parse(body) : {};
  const keys = Object.keys(args);
  const sql = `select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  try {
    const out = await pool.query(sql, keys.map((k) => args[k]));
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(out.rows[0]?.r ?? null));
  } catch (e) {
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' })
      .end(JSON.stringify({ code: e.code ?? 'P0001', message: e.message, details: null, hint: null }));
  }
}).listen(HTTP_PORT, () => {
  console.log(`Local backend on http://localhost:${HTTP_PORT}  (admin password: ${ADMIN_PASSWORD})`);
});

const shutdown = async () => {
  await pool.end().catch(() => {});
  await server.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Boots a real PostgreSQL server (embedded-postgres), creates the roles that
// Supabase provides (anon, authenticated) and applies the migration exactly as
// it would be applied to a Supabase project.
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

const PORT = 54329 + Math.floor(Math.random() * 500);

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'buzzer-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    postgresFlags: ['-c', 'max_connections=200'],
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('buzzer_test');

  const url = `postgres://postgres:postgres@localhost:${PORT}/buzzer_test`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`
    create role anon nologin;
    create role authenticated nologin;
    create schema extensions;
    grant usage on schema public, extensions to anon, authenticated;
  `);
  const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  await client.end();

  project.provide('dbUrl', url);

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

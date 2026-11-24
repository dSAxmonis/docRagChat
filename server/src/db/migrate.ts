import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const defaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const LOCK_KEY = 727274

/** Applies every *.sql file in name order, once, each inside its own transaction. */
export async function migrate(pool: pg.Pool, dir = defaultDir): Promise<string[]> {
  const client = await pool.connect()
  try {
    // Serialise concurrent boots (e.g. two instances starting at once)
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    )
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(dir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
    }
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    client.release()
  }
}

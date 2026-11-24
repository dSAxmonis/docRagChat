import pg from 'pg'

/**
 * node-postgres pool. Fits a long-running server: connections are reused across requests.
 * TLS comes from the URL (e.g. Neon's `sslmode=require`) unless DATABASE_SSL forces it on.
 */
export function createPool(connectionString: string, ssl: boolean, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max,
    // Neon scales idle computes to zero; give the first connection time to wake it
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
  })
  // An idle client dropped by the server must not crash the process
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message))
  return pool
}

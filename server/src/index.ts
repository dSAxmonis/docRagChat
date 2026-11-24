import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeminiChat, GeminiEmbedder } from './ai/gemini.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { migrate } from './db/migrate.js'
import { createPool } from './db/pool.js'
import { PgStore } from './db/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = loadConfig()
  const pool = createPool(config.DATABASE_URL, config.DATABASE_SSL)

  const applied = await migrate(pool)
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`)

  const app = createApp(
    {
      store: new PgStore(pool),
      embedder: new GeminiEmbedder({
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_EMBED_MODEL,
        dimensions: config.EMBED_DIM,
      }),
      chat: new GeminiChat({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_CHAT_MODELS }),
    },
    {
      maxUploadMb: config.MAX_UPLOAD_MB,
      chunkSize: config.CHUNK_SIZE,
      chunkOverlap: config.CHUNK_OVERLAP,
      topK: config.TOP_K,
      chatRateLimitPerMin: config.CHAT_RATE_LIMIT_PER_MIN,
      trustProxy: config.NODE_ENV === 'production',
      staticDir: process.env.STATIC_DIR ?? path.resolve(here, '../../web/dist'),
    },
  )

  const server = app.listen(config.PORT, () => console.log(`Listening on :${config.PORT}`))

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`)
    server.close(() => pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  /** Direct (non-pooled) URL for migrations; Neon's PgBouncer pooler can't hold session advisory locks. */
  DATABASE_URL_UNPOOLED: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  /** Comma-separated; tried in order when a model is overloaded or retired. */
  GEMINI_CHAT_MODELS: z
    .string()
    .default('gemini-flash-lite-latest,gemini-flash-latest,gemini-3.8-flash')
    .transform((v) => v.split(',').map((m) => m.trim()).filter(Boolean))
    .refine((v) => v.length > 0, 'at least one model is required'),
  GEMINI_EMBED_MODEL: z.string().default('gemini-embedding-001'),
  EMBED_DIM: z.coerce.number().int().positive().default(768),
  CHUNK_SIZE: z.coerce.number().int().min(100).default(800),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(100),
  TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  if (parsed.data.CHUNK_OVERLAP >= parsed.data.CHUNK_SIZE) {
    throw new Error('Invalid configuration: CHUNK_OVERLAP must be smaller than CHUNK_SIZE')
  }
  return parsed.data
}

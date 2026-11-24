import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_CHAT_MODEL: z.string().default('gemini-2.5-flash'),
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

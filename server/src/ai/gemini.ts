import { ProviderError, type ChatModel, type Embedder } from './types.js'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
/** batchEmbedContents accepts at most 100 requests per call. */
const EMBED_BATCH = 100
const MAX_RETRIES = 4
const TIMEOUT_MS = 60_000
const CHAT_FALLBACK_TIMEOUT_MS = 25_000

type FetchFn = typeof fetch

interface GeminiOptions {
  apiKey: string
  fetchFn?: FetchFn
  /** Base delay for exponential backoff; tests set this to 0. */
  retryBaseMs?: number
  /** Retries per request for 429/5xx/network errors. */
  maxRetries?: number
  /** Per-attempt timeout. */
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** POST JSON to Gemini, retrying 429 and 5xx responses with exponential backoff. */
async function callGemini<T>(path: string, body: unknown, opts: GeminiOptions): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch
  const base = opts.retryBaseMs ?? 1000
  const maxRetries = opts.maxRetries ?? MAX_RETRIES
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetchFn(`${BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      })
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(base * 2 ** attempt)
        continue
      }
      throw new ProviderError(`Gemini request failed: ${(err as Error).message}`)
    }
    if (res.ok) return (await res.json()) as T

    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < maxRetries) {
      await sleep(base * 2 ** attempt)
      continue
    }
    const detail = await res.text().catch(() => '')
    let message = detail
    try {
      message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail
    } catch {
      /* not JSON */
    }
    throw new ProviderError(`Gemini ${res.status}: ${message.slice(0, 300)}`, res.status)
  }
}

export class GeminiEmbedder implements Embedder {
  constructor(
    private opts: GeminiOptions & { model: string; dimensions: number },
  ) {}

  private async embed(texts: string[], taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY') {
    const model = `models/${this.opts.model}`
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH)
      const data = await callGemini<{ embeddings?: { values: number[] }[] }>(
        `${model}:batchEmbedContents`,
        {
          requests: batch.map((text) => ({
            model,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: this.opts.dimensions,
          })),
        },
        this.opts,
      )
      const embeddings = data.embeddings ?? []
      if (embeddings.length !== batch.length) {
        throw new ProviderError(`Gemini returned ${embeddings.length} embeddings for ${batch.length} inputs`)
      }
      for (const e of embeddings) {
        if (e.values.length !== this.opts.dimensions) {
          throw new ProviderError(`Expected ${this.opts.dimensions}-d embedding, got ${e.values.length}`)
        }
        out.push(e.values)
      }
    }
    return out
  }

  embedDocuments(texts: string[]) {
    return this.embed(texts, 'RETRIEVAL_DOCUMENT')
  }

  async embedQuery(text: string) {
    return (await this.embed([text], 'RETRIEVAL_QUERY'))[0]
  }
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
}

/** Errors worth trying the next model for: overloaded, rate limited, or model retired/unknown. */
const shouldFallBack = (err: unknown) =>
  err instanceof ProviderError && (err.status === undefined || err.status === 404 || err.status === 429 || err.status >= 500)

/**
 * Chat client that tries each model in order. Free-tier flash models are often briefly
 * overloaded (503) and older ones get retired (404), so a fallback list keeps chat working.
 */
export class GeminiChat implements ChatModel {
  private models: string[]

  constructor(private opts: GeminiOptions & { model: string | string[] }) {
    this.models = (Array.isArray(opts.model) ? opts.model : [opts.model]).filter(Boolean)
    if (this.models.length === 0) throw new Error('GeminiChat needs at least one model')
  }

  async generate({ system, prompt }: { system: string; prompt: string }) {
    let lastError: unknown
    for (const [i, model] of this.models.entries()) {
      try {
        return await this.generateWith(model, system, prompt)
      } catch (err) {
        lastError = err
        if (i === this.models.length - 1 || !shouldFallBack(err)) throw err
        console.warn(`[gemini] ${model} failed (${(err as Error).message}); falling back to ${this.models[i + 1]}`)
      }
    }
    throw lastError
  }

  private async generateWith(model: string, system: string, prompt: string) {
    const data = await callGemini<GenerateResponse>(
      `models/${model}:generateContent`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      },
      // Fail over quickly instead of retrying one overloaded model for a long time
      {
        ...this.opts,
        maxRetries: this.opts.maxRetries ?? (this.models.length > 1 ? 1 : MAX_RETRIES),
        // Overloaded models sometimes hang instead of answering 503
        timeoutMs: this.opts.timeoutMs ?? (this.models.length > 1 ? CHAT_FALLBACK_TIMEOUT_MS : TIMEOUT_MS),
      },
    )
    if (data.promptFeedback?.blockReason) {
      throw new ProviderError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, 400)
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
    if (!text) throw new ProviderError('Gemini returned an empty answer', 502)
    return text
  }
}

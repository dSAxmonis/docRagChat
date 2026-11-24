import { describe, expect, it, vi } from 'vitest'
import { GeminiChat, GeminiEmbedder } from '../src/ai/gemini.js'
import { ProviderError } from '../src/ai/types.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('GeminiEmbedder', () => {
  it('batches requests at 100 and keeps output order', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { requests } = JSON.parse(String(init?.body)) as { requests: { content: { parts: { text: string }[] } }[] }
      return json({ embeddings: requests.map((r) => ({ values: [Number(r.content.parts[0].text), 0, 0] })) })
    })
    const e = new GeminiEmbedder({ apiKey: 'k', model: 'm', dimensions: 3, fetchFn: fetchFn as typeof fetch })
    const texts = Array.from({ length: 250 }, (_, i) => String(i))
    const out = await e.embedDocuments(texts)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(out.map((v) => v[0])).toEqual(texts.map(Number))
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toContain('models/m:batchEmbedContents')
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('k')
  })

  it('retries on 429 then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: 'quota' } }, 429))
      .mockResolvedValueOnce(json({ embeddings: [{ values: [1, 2] }] }))
    const e = new GeminiEmbedder({ apiKey: 'k', model: 'm', dimensions: 2, fetchFn, retryBaseMs: 0 })
    expect(await e.embedQuery('q')).toEqual([1, 2])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('fails fast on 400 with the provider message', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ error: { message: 'API key not valid' } }, 400))
    const e = new GeminiEmbedder({ apiKey: 'k', model: 'm', dimensions: 2, fetchFn, retryBaseMs: 0 })
    await expect(e.embedQuery('q')).rejects.toThrow(/400: API key not valid/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects embeddings of the wrong dimension', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ embeddings: [{ values: [1, 2, 3] }] }))
    const e = new GeminiEmbedder({ apiKey: 'k', model: 'm', dimensions: 2, fetchFn })
    await expect(e.embedQuery('q')).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('GeminiChat', () => {
  it('sends the system prompt and returns joined text parts', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      json({ candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'there [1]' }] } }] }),
    )
    const chat = new GeminiChat({ apiKey: 'k', model: 'flash', fetchFn })
    expect(await chat.generate({ system: 'sys', prompt: 'p' })).toBe('Hello there [1]')
    const body = JSON.parse(String(fetchFn.mock.calls[0][1].body))
    expect(body.systemInstruction.parts[0].text).toBe('sys')
    expect(body.contents[0].parts[0].text).toBe('p')
  })

  it('throws on an empty or blocked answer', async () => {
    const empty = vi.fn().mockResolvedValue(json({ candidates: [] }))
    await expect(new GeminiChat({ apiKey: 'k', model: 'm', fetchFn: empty }).generate({ system: '', prompt: '' })).rejects.toThrow(
      /empty/,
    )
    const blocked = vi.fn().mockResolvedValue(json({ promptFeedback: { blockReason: 'SAFETY' } }))
    await expect(new GeminiChat({ apiKey: 'k', model: 'm', fetchFn: blocked }).generate({ system: '', prompt: '' })).rejects.toThrow(
      /SAFETY/,
    )
  })
})

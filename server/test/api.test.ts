import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProviderError } from '../src/ai/types.js'
import { createApp, type AppOptions } from '../src/app.js'
import { NO_CONTEXT_ANSWER } from '../src/rag/answer.js'
import { makeFakes } from './helpers/fakes.js'
import { makePdf } from './helpers/pdf.js'

const opts: AppOptions = {
  maxUploadMb: 5,
  chunkSize: 200,
  chunkOverlap: 20,
  topK: 5,
  chatRateLimitPerMin: 100,
}

const CATS = 'Cats sleep for most of the day. Cats purr when they are content.'
const SPACE = 'The Moon orbits the Earth. Rockets need fuel to reach orbit around the Moon.'

let fakes: ReturnType<typeof makeFakes>
let app: ReturnType<typeof createApp>

beforeEach(() => {
  fakes = makeFakes()
  app = createApp(fakes, opts)
})

const uploadText = (name: string, text: string, type = 'text/plain') =>
  request(app).post('/api/documents').attach('file', Buffer.from(text), { filename: name, contentType: type })

describe('GET /api/health', () => {
  it('reports ok when the database responds', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', db: 'up' })
  })

  it('reports 503 when the database is down', async () => {
    fakes.store.healthy = false
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.db).toBe('down')
  })
})

describe('POST /api/documents', () => {
  it('chunks, embeds and stores a text file', async () => {
    const res = await uploadText('notes.txt', `${CATS}\n\n${SPACE}`.repeat(3))
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' })
    expect(res.body.document.chunkCount).toBeGreaterThan(1)
    expect(fakes.embedder.embedDocuments).toHaveBeenCalledTimes(1)
    const stored = fakes.store.chunks.get(res.body.document.id)!
    expect(stored).toHaveLength(res.body.document.chunkCount)
    expect(stored.every((c) => c.content.length <= opts.chunkSize)).toBe(true)
  })

  it('accepts markdown sent as application/octet-stream and keeps UTF-8 names', async () => {
    const res = await uploadText('résumé.md', '# Hi\n\nSome text', 'application/octet-stream')
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ name: 'résumé.md', mimeType: 'text/markdown' })
  })

  it('accepts a PDF', async () => {
    const res = await request(app)
      .post('/api/documents')
      .attach('file', makePdf(['Quarterly revenue grew 12 percent.']), {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
    expect(res.status).toBe(201)
    expect(fakes.store.chunks.get(res.body.document.id)![0].content).toContain('Quarterly revenue')
  })

  it('rejects files over the size limit with 413', async () => {
    const res = await uploadText('big.txt', 'a'.repeat(5 * 1024 * 1024 + 1))
    expect(res.status).toBe(413)
    expect(res.body.error).toMatch(/5 MB/)
    expect(fakes.store.docs.size).toBe(0)
  })

  it('rejects unsupported types with 415', async () => {
    const res = await uploadText('image.png', 'x', 'image/png')
    expect(res.status).toBe(415)
  })

  it('rejects empty files with 422', async () => {
    const res = await uploadText('empty.txt', '   \n')
    expect(res.status).toBe(422)
  })

  it('rejects a request without a file with 400', async () => {
    const res = await request(app).post('/api/documents')
    expect(res.status).toBe(400)
  })

  it('returns 502 and stores nothing when embedding fails', async () => {
    fakes.embedder.embedDocuments.mockRejectedValueOnce(new ProviderError('boom', 500))
    const res = await uploadText('a.txt', CATS)
    expect(res.status).toBe(502)
    expect(fakes.store.docs.size).toBe(0)
  })
})

describe('GET and DELETE /api/documents', () => {
  it('lists uploaded documents and deletes one', async () => {
    const a = (await uploadText('a.txt', CATS)).body.document
    await uploadText('b.txt', SPACE)

    let list = await request(app).get('/api/documents')
    expect(list.body.documents.map((d: { name: string }) => d.name).sort()).toEqual(['a.txt', 'b.txt'])

    expect((await request(app).delete(`/api/documents/${a.id}`)).status).toBe(204)
    list = await request(app).get('/api/documents')
    expect(list.body.documents).toHaveLength(1)
    expect(fakes.store.chunks.has(a.id)).toBe(false)
  })

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    expect((await request(app).delete('/api/documents/00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await request(app).delete('/api/documents/not-a-uuid')).status).toBe(400)
  })
})

describe('POST /api/chat', () => {
  it('answers from the selected documents with sources', async () => {
    const cats = (await uploadText('cats.txt', CATS)).body.document
    const space = (await uploadText('space.txt', SPACE)).body.document

    const res = await request(app)
      .post('/api/chat')
      .send({ question: 'Why do cats purr?', documentIds: [cats.id, space.id] })

    expect(res.status).toBe(200)
    expect(res.body.answer).toBe('Mocked answer [1].')
    expect(res.body.sources.length).toBeGreaterThan(0)
    expect(res.body.sources.length).toBeLessThanOrEqual(5)
    expect(res.body.sources[0]).toMatchObject({ n: 1, documentName: 'cats.txt', chunkIndex: 0 })
    expect(res.body.sources[0].snippet).toContain('purr')

    const { system, prompt } = fakes.chat.generate.mock.calls[0][0]
    expect(system).toMatch(/only the numbered context/)
    expect(prompt).toContain('[1] (cats.txt, chunk 1)')
    expect(prompt).toContain('Question: Why do cats purr?')
  })

  it('only retrieves from the documents that were selected', async () => {
    const cats = (await uploadText('cats.txt', CATS)).body.document
    await uploadText('space.txt', SPACE)

    const res = await request(app).post('/api/chat').send({ question: 'Moon orbit?', documentIds: [cats.id] })
    expect(res.body.sources.every((s: { documentId: string }) => s.documentId === cats.id)).toBe(true)
  })

  it('returns at most topK sources', async () => {
    const doc = (await uploadText('long.txt', `${CATS}\n\n`.repeat(30))).body.document
    const res = await request(app).post('/api/chat').send({ question: 'cats', documentIds: [doc.id] })
    expect(res.body.sources).toHaveLength(5)
  })

  it('skips the LLM when nothing is retrieved', async () => {
    const doc = (await uploadText('a.txt', CATS)).body.document
    fakes.store.chunks.set(doc.id, [])
    const res = await request(app).post('/api/chat').send({ question: 'anything', documentIds: [doc.id] })
    expect(res.body).toEqual({ answer: NO_CONTEXT_ANSWER, sources: [] })
    expect(fakes.chat.generate).not.toHaveBeenCalled()
  })

  it('validates the request body', async () => {
    const id = (await uploadText('a.txt', CATS)).body.document.id
    expect((await request(app).post('/api/chat').send({ question: '  ', documentIds: [id] })).status).toBe(400)
    expect((await request(app).post('/api/chat').send({ question: 'hi', documentIds: [] })).status).toBe(400)
    expect((await request(app).post('/api/chat').send({ question: 'hi', documentIds: ['x'] })).status).toBe(400)
    const bad = await request(app).post('/api/chat').set('content-type', 'application/json').send('{bad')
    expect(bad.status).toBe(400)
  })

  it('returns 404 when a selected document was deleted', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ question: 'hi', documentIds: ['00000000-0000-4000-8000-000000000000'] })
    expect(res.status).toBe(404)
  })

  it('maps provider quota errors to 503', async () => {
    const id = (await uploadText('a.txt', CATS)).body.document.id
    fakes.chat.generate.mockRejectedValueOnce(new ProviderError('quota', 429))
    const res = await request(app).post('/api/chat').send({ question: 'cats', documentIds: [id] })
    expect(res.status).toBe(503)
  })

  it('rate limits chat requests per client', async () => {
    const limited = createApp(fakes, { ...opts, chatRateLimitPerMin: 2 })
    const id = (await request(limited).post('/api/documents').attach('file', Buffer.from(CATS), 'a.txt')).body
      .document.id
    const ask = () => request(limited).post('/api/chat').send({ question: 'cats', documentIds: [id] })
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    const third = await ask()
    expect(third.status).toBe(429)
    expect(third.body.error).toMatch(/Too many/)
    // Other endpoints are not limited
    expect((await request(limited).get('/api/documents')).status).toBe(200)
  })
})

describe('frontend serving', () => {
  it('serves index.html for client routes from a relative static dir', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'web-'))
    writeFileSync(path.join(dir, 'index.html'), '<h1>app</h1>')
    const web = createApp(fakes, { ...opts, staticDir: path.relative(process.cwd(), dir) })
    for (const url of ['/', '/some/page']) {
      const res = await request(web).get(url)
      expect(res.status).toBe(200)
      expect(res.text).toContain('<h1>app</h1>')
    }
    expect((await request(web).get('/api/nope')).status).toBe(404)
  })
})

describe('unknown routes', () => {
  it('returns JSON 404 under /api', async () => {
    const res = await request(app).get('/api/nope')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Not found')
  })
})

describe('client IP behind proxies', () => {
  it('rate limits by the client IP found the configured number of hops back', async () => {
    // Mirrors Render: X-Forwarded-For = client, cloudflare-1, cloudflare-2 (the LB is the socket peer)
    const proxied = createApp(fakes, { ...opts, chatRateLimitPerMin: 1, trustProxyHops: 3 })
    const ask = (xff: string) =>
      request(proxied).post('/api/chat').set('x-forwarded-for', xff).send({ question: 'x', documentIds: [] })
    expect((await ask('9.9.9.9, 104.22.0.1, 104.23.0.1')).status).toBe(400)
    // Same client via different Cloudflare edges, plus a spoofed left-most entry: same bucket
    expect((await ask('6.6.6.6, 9.9.9.9, 104.22.0.2, 104.23.0.2')).status).toBe(429)
    // A different client gets its own bucket
    expect((await ask('8.8.8.8, 104.22.0.1, 104.23.0.1')).status).toBe(400)
  })
})

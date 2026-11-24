import { existsSync } from 'node:fs'
import path from 'node:path'
import express, { type ErrorRequestHandler, type Request, type Response } from 'express'
import multer from 'multer'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { ProviderError, type ChatModel, type Embedder } from './ai/types.js'
import type { Store } from './db/store.js'
import { answerQuestion } from './rag/answer.js'
import { chunkText } from './rag/chunker.js'
import { detectKind, EmptyDocumentError, extractText, MIME_FOR_KIND, UnsupportedFileError } from './rag/parsers.js'

export interface AppOptions {
  maxUploadMb: number
  chunkSize: number
  chunkOverlap: number
  topK: number
  chatRateLimitPerMin: number
  trustProxy?: boolean
  /** Directory with the built frontend; served when present. */
  staticDir?: string
}

export interface AppDeps {
  store: Store
  embedder: Embedder
  chat: ChatModel
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const uuid = z.uuid()

const chatBody = z.object({
  question: z.string().trim().min(1, 'question is required').max(2000, 'question is too long'),
  documentIds: z.array(uuid).min(1, 'select at least one document').max(50),
})

/** multer decodes multipart filenames as latin1; browsers send UTF-8. */
const decodeFilename = (name: string) => Buffer.from(name, 'latin1').toString('utf8').slice(0, 255)

export function createApp(deps: AppDeps, opts: AppOptions) {
  const app = express()
  app.disable('x-powered-by')
  if (opts.trustProxy) app.set('trust proxy', 1)
  app.use(express.json({ limit: '100kb' }))

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxUploadMb * 1024 * 1024, files: 1 },
  })

  const chatLimiter = rateLimit({
    windowMs: 60_000,
    limit: opts.chatRateLimitPerMin,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many chat requests, please wait a minute and try again' })
    },
  })

  const api = express.Router()

  api.get('/health', async (_req, res) => {
    try {
      await deps.store.ping()
      res.json({ status: 'ok', db: 'up' })
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' })
    }
  })

  api.get('/documents', async (_req, res) => {
    res.json({ documents: await deps.store.listDocuments() })
  })

  api.post('/documents', upload.single('file'), async (req, res) => {
    const file = req.file
    if (!file) throw new HttpError(400, 'Attach a file in the "file" field')
    const name = decodeFilename(file.originalname)
    const kind = detectKind(name, file.mimetype)
    const text = await extractText(file.buffer, kind)
    const pieces = chunkText(text, { size: opts.chunkSize, overlap: opts.chunkOverlap })
    if (pieces.length === 0) throw new EmptyDocumentError('File is empty')
    const embeddings = await deps.embedder.embedDocuments(pieces)
    const doc = await deps.store.createDocument(
      { name, mimeType: MIME_FOR_KIND[kind], sizeBytes: file.size },
      pieces.map((content, index) => ({ index, content, embedding: embeddings[index] })),
    )
    res.status(201).json({ document: doc })
  })

  api.delete('/documents/:id', async (req, res) => {
    const id = req.params.id
    if (!uuid.safeParse(id).success) throw new HttpError(400, 'Invalid document id')
    if (!(await deps.store.deleteDocument(id))) throw new HttpError(404, 'Document not found')
    res.status(204).end()
  })

  api.post('/chat', chatLimiter, async (req, res) => {
    const parsed = chatBody.safeParse(req.body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message)
    const { question } = parsed.data
    const documentIds = [...new Set(parsed.data.documentIds)]
    const existing = await deps.store.existingDocumentIds(documentIds)
    if (existing.length !== documentIds.length) {
      throw new HttpError(404, 'One or more selected documents no longer exist')
    }
    res.json(await answerQuestion(deps, question, documentIds, opts.topK))
  })

  api.use((_req, _res) => {
    throw new HttpError(404, 'Not found')
  })

  app.use('/api', api)

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const staticDir = path.resolve(opts.staticDir)
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }))
    app.get('/{*splat}', (_req: Request, res: Response) => {
      res.sendFile(path.join(staticDir, 'index.html'))
    })
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
    } else if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE'
      res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? `File is larger than ${opts.maxUploadMb} MB` : err.message })
    } else if (err instanceof UnsupportedFileError) {
      res.status(415).json({ error: err.message })
    } else if (err instanceof EmptyDocumentError) {
      res.status(422).json({ error: err.message })
    } else if (err instanceof ProviderError) {
      console.error('[provider]', err.message)
      res
        .status(err.status === 429 ? 503 : 502)
        .json({ error: err.status === 429 ? 'AI provider quota reached, try again shortly' : 'AI provider error' })
    } else if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body' })
    } else if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large' })
    } else {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
  app.use(errorHandler)

  return app
}

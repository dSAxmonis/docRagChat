import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { ChatModel, Embedder } from '../../src/ai/types.js'
import type { DocumentRow, NewChunk, NewDocument, RetrievedChunk, Store } from '../../src/db/store.js'

const DIM = 8

/** Deterministic toy embedding: bag of hashed words, so related texts score higher. */
export function toyEmbed(text: string): number[] {
  const v = new Array(DIM).fill(0)
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    v[h % DIM] += 1
  }
  return v
}

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0)
  const na = Math.hypot(...a)
  const nb = Math.hypot(...b)
  return na && nb ? dot / (na * nb) : 0
}

export class MemoryStore implements Store {
  docs = new Map<string, DocumentRow>()
  chunks = new Map<string, NewChunk[]>()
  healthy = true

  async ping() {
    if (!this.healthy) throw new Error('db down')
  }

  async createDocument(doc: NewDocument, chunks: NewChunk[]) {
    const row: DocumentRow = {
      id: randomUUID(),
      ...doc,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
    }
    this.docs.set(row.id, row)
    this.chunks.set(row.id, chunks)
    return row
  }

  async listDocuments() {
    return [...this.docs.values()].reverse()
  }

  async deleteDocument(id: string) {
    this.chunks.delete(id)
    return this.docs.delete(id)
  }

  async existingDocumentIds(ids: string[]) {
    return ids.filter((id) => this.docs.has(id))
  }

  async searchChunks(embedding: number[], documentIds: string[], k: number) {
    const hits: RetrievedChunk[] = []
    for (const id of documentIds) {
      const doc = this.docs.get(id)
      for (const c of this.chunks.get(id) ?? []) {
        hits.push({
          documentId: id,
          documentName: doc!.name,
          chunkIndex: c.index,
          content: c.content,
          score: cosine(embedding, c.embedding),
        })
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k)
  }
}

export function makeFakes() {
  const embedder = {
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(toyEmbed)),
    embedQuery: vi.fn(async (text: string) => toyEmbed(text)),
  } satisfies Embedder
  const chat = {
    generate: vi.fn(async (_input: { system: string; prompt: string }) => 'Mocked answer [1].'),
  } satisfies ChatModel
  return { store: new MemoryStore(), embedder, chat }
}

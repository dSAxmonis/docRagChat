import type pg from 'pg'

export interface DocumentRow {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  chunkCount: number
  createdAt: string
}

export interface NewDocument {
  name: string
  mimeType: string
  sizeBytes: number
}

export interface NewChunk {
  index: number
  content: string
  embedding: number[]
}

export interface RetrievedChunk {
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  score: number
}

/** Persistence boundary. The API depends on this interface so tests can use an in-memory fake. */
export interface Store {
  ping(): Promise<void>
  createDocument(doc: NewDocument, chunks: NewChunk[]): Promise<DocumentRow>
  listDocuments(): Promise<DocumentRow[]>
  deleteDocument(id: string): Promise<boolean>
  existingDocumentIds(ids: string[]): Promise<string[]>
  searchChunks(embedding: number[], documentIds: string[], k: number): Promise<RetrievedChunk[]>
}

const toVector = (v: number[]) => `[${v.join(',')}]`

const DOC_COLUMNS = `id, name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
  chunk_count AS "chunkCount", created_at AS "createdAt"`

const INSERT_BATCH = 500

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  async ping() {
    await this.pool.query('SELECT 1')
  }

  async createDocument(doc: NewDocument, chunks: NewChunk[]) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<DocumentRow>(
        `INSERT INTO documents (name, mime_type, size_bytes, chunk_count) VALUES ($1, $2, $3, $4)
         RETURNING ${DOC_COLUMNS}`,
        [doc.name, doc.mimeType, doc.sizeBytes, chunks.length],
      )
      const row = rows[0]
      // Multi-row inserts in batches keep the parameter count well under pg's 65535 limit
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const batch = chunks.slice(i, i + INSERT_BATCH)
        const params: unknown[] = []
        const values = batch.map((c, j) => {
          params.push(row.id, c.index, c.content, toVector(c.embedding))
          const b = j * 4
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::vector)`
        })
        await client.query(
          `INSERT INTO chunks (document_id, chunk_index, content, embedding) VALUES ${values.join(',')}`,
          params,
        )
      }
      await client.query('COMMIT')
      return row
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async listDocuments() {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT ${DOC_COLUMNS} FROM documents ORDER BY created_at DESC`,
    )
    return rows
  }

  async deleteDocument(id: string) {
    const { rowCount } = await this.pool.query('DELETE FROM documents WHERE id = $1', [id])
    return (rowCount ?? 0) > 0
  }

  async existingDocumentIds(ids: string[]) {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM documents WHERE id = ANY($1::uuid[])',
      [ids],
    )
    return rows.map((r) => r.id)
  }

  async searchChunks(embedding: number[], documentIds: string[], k: number) {
    const { rows } = await this.pool.query<RetrievedChunk>(
      `SELECT c.document_id AS "documentId", d.name AS "documentName", c.chunk_index AS "chunkIndex",
              c.content, 1 - (c.embedding <=> $1::vector) AS score
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.document_id = ANY($2::uuid[])
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3`,
      [toVector(embedding), documentIds, k],
    )
    return rows.map((r) => ({ ...r, score: Number(r.score) }))
  }
}

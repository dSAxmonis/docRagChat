CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  integer NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content     text NOT NULL,
  -- Dimension must match EMBED_DIM (gemini-embedding-001 with outputDimensionality=768)
  embedding   vector(768) NOT NULL,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX chunks_document_id_idx ON chunks(document_id);
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);

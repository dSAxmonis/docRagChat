# Design decisions

Short notes on the choices made, why, and what they cost.

## 1. One deployable service
Express serves both `/api` and the built React app. This gives one Docker image, one Render service and no CORS, and the frontend calls relative `/api/...` URLs.
*Trade-off:* the frontend and API can't scale or deploy separately. That's fine at this size.

## 2. Gemini for chat and embeddings
The requirement was "free, with the most tokens". Gemini's free tier covers both chat (the Flash family) and embeddings (`gemini-embedding-001`) with a single key.
- The client calls the REST API with `fetch` instead of using an SDK. It's about 100 lines, has no SDK churn, and is easy to mock.
- Embedder and LLM sit behind small `Embedder` / `ChatModel` interfaces, so swapping providers is one new class.
- Chat goes through a list of fallback models (`gemini-flash-lite-latest` → `gemini-flash-latest` → `gemini-3.8-flash`). Lite goes first because it was the only one answering reliably on the free tier, and with retrieved passages and citations a lite model is good enough. While building this, the flash models returned 503 "high demand" for minutes at a time and `gemini-2.5-flash` had been retired for new keys (404). When that happens, the client moves on to the next model after one quick retry, with a 25 s cap per attempt (overloaded models sometimes hang instead of returning 503). Using the `-latest` aliases avoids having to edit code each time Google retires a model.
- Free-tier limits are low (per-minute token caps). The client retries `429` and `5xx` with exponential backoff. A quota error that persists becomes a clear `503` ("quota reached"), and other provider failures become `502`.
*Trade-off:* a large upload (hundreds of chunks) can be slow or hit the free quota. A paid key removes this.

## 3. 768-dimension embeddings
`gemini-embedding-001` supports Matryoshka truncation (`outputDimensionality`). 768 dimensions keep retrieval quality close to the full 3072 while staying under pgvector's 2000-dimension limit for HNSW indexes, and they use 4× less storage. The dimension is fixed in the migration (`vector(768)`) and checked at runtime, so a mismatch fails loudly instead of corrupting data.
Documents are embedded with `RETRIEVAL_DOCUMENT` and questions with `RETRIEVAL_QUERY`, which is the asymmetric setup the model was trained for.

## 4. pgvector with an HNSW cosine index
Similarity is `ORDER BY embedding <=> $q` (cosine distance), filtered to the selected document ids, `LIMIT 5`. HNSW gives good recall without tuning, and unlike IVFFlat it needs no training step on existing data.
*Trade-off:* the HNSW index is global across all documents. With a narrow document filter on a very large table, post-filtering can return fewer than k rows. At this scale that doesn't come up. The fixes would be iterative scan (`hnsw.iterative_scan`, pgvector 0.8+) or partitioning.

## 5. Plain `pg` and plain SQL migrations
No ORM, as the brief asked. A roughly 40-line runner applies `migrations/*.sql` in order and records each one in `schema_migrations`. Each file runs in a transaction, and a Postgres advisory lock stops two instances that boot at the same time from racing. Migrations run on startup, so a deploy needs no separate step.

## 6. Chunking: recursive character splitter
The text is split at the coarsest boundary that fits (paragraph → line → sentence → word → hard cut). The pieces are then packed greedily into chunks of at most 800 characters. Each new chunk starts with up to 100 characters of *whole* trailing pieces from the previous chunk, so the overlap never starts mid-word.
- Measured in characters rather than tokens: deterministic, has no tokenizer dependency, and is simple to unit test.
- 800 characters is roughly 200 tokens, small enough that 5 chunks give a focused context.

## 7. Upload handling
- multer keeps the file in memory with a hard 5 MB limit (413 above it), so nothing touches disk and it works on read-only containers.
- Both the extension *and* the MIME type must match. `application/octet-stream` is also accepted, because browsers send it for `.md`. PDFs also need the `%PDF-` magic bytes, and text files must not contain NUL bytes.
- **pdf-parse** (pdf.js) is used for PDFs. Its library file is imported directly, because the package entry point runs a debug harness when loaded from ESM.
- Bug found while testing: small Node Buffers are slices of a shared memory pool, and the bundled pdf.js reads the whole underlying `ArrayBuffer`, ignoring the slice offset. Small PDFs then fail with "bad XRef entry". The fix is to copy into a standalone `Uint8Array` before parsing.
- Scanned (image-only) PDFs have no text layer and are rejected with a clear 422. OCR is out of scope.
- Chunks are embedded *before* the database transaction opens, and the document and all its chunks are inserted in one transaction. A failed embedding stores nothing, and no half-written document ever shows up in the list.

## 8. Prompting and citations
Retrieved chunks are numbered `[1]…[5]` in the prompt, with document name and chunk number. The system prompt says to answer only from those passages, cite every claim as `[n]`, say "I don't know" when the context doesn't contain the answer, and treat passage text as data, not instructions (a basic guard against prompt injection from uploaded files). The API returns the sources with the same numbers, so the UI can map citations to snippets.
If retrieval returns nothing, the LLM is skipped entirely and a fixed "nothing relevant" answer comes back.

## 9. Rate limiting
`express-rate-limit` applies to `/api/chat` only, because that's where cost is: each call is one embedding plus one LLM call. The default is 20 requests per minute per IP, in memory. `trust proxy` is turned on in production so Render's load balancer doesn't make every user share one IP.
*Trade-off:* the in-memory store is per instance. Running more than one instance would need a Redis store.

## 10. Answers are not streamed
`/api/chat` returns the whole answer in one JSON response. That keeps the API, error handling and tests simple. Streaming (SSE) would improve perceived speed and is the obvious next step.

## 11. Testing strategy
- **Unit:** chunker (sizes, overlap, boundaries, edge cases), parsers (type checks, PDF extraction with a PDF generated inside the test), Gemini client (batching, retry, error mapping, with a mocked `fetch`).
- **API:** supertest against `createApp()` with dependency injection: a mocked embedder (deterministic bag-of-words vectors, so retrieval ranking actually means something), a mocked LLM, and an in-memory `Store` that does real cosine search. No database or API key is needed, so `npm test` runs anywhere, including CI.
*Trade-off:* the pgvector SQL itself isn't covered by automated tests (pg-mem can't emulate pgvector). It was checked by hand against the Docker Compose database. A CI job with a `pgvector/pgvector` service container would be the next addition.

## 12. Frontend
One React page. It was built first with plain HTML and under 20 lines of CSS on `--bg`, `--text`, `--accent` and `--font`, so the theme could go on afterwards without changing how the page works. The theme follows a reference mock-up: a near-black background with an orange glow, orange gradient bubbles for user messages, glassy answer cards with numbered citation chips, documents as cards you tap to select, and a pill-shaped composer whose paperclip button uploads. Everything stays on one screen. All documents start selected, and newly uploaded ones are selected automatically.

## 13. Deployment
- **Docker:** a multi-stage build on `node:22-alpine`. The runtime image holds only the server's production dependencies plus the compiled server and frontend, runs as the non-root `node` user, and has a `HEALTHCHECK`.
- **Render Blueprint:** one Docker web service plus one managed Postgres (16), which supports `CREATE EXTENSION vector`. The API key is a `sync: false` secret, so it never lives in the repo.
- **Free-tier limits:** the service sleeps when idle (cold start of about 30 s), and the database expires after 30 days.

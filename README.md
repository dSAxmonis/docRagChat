# docRagChat: Document RAG Chatbot

Upload PDF, TXT or Markdown files and chat with them. Answers are grounded in the top-5 most similar passages (pgvector) and cite their sources.

**Stack:** Node.js + TypeScript + Express · PostgreSQL + pgvector (plain `pg`, SQL migrations) · React + Vite + TypeScript · Google Gemini (chat + embeddings) · Docker · GitHub Actions · Render

## Features

- Upload `.pdf`, `.txt`, `.md` (5 MB max). The text is chunked, embedded and stored.
- List and delete documents. Deleting a document cascades to its chunks.
- Chat over the documents you tick. It retrieves the top 5 chunks by cosine similarity and answers with `[n]` citations plus a sources list.
- `GET /api/health` checks the database too.
- Per-IP rate limit on chat (default 20/min).
- All settings come from env vars, validated at startup.

## Quick start (Docker)

```bash
cp .env.example .env              # put your Gemini key in GEMINI_API_KEY
docker compose up --build
open http://localhost:3000
```

Get a free Gemini key at <https://aistudio.google.com/apikey>.

## Local development

```bash
npm install
cp .env.example .env              # add GEMINI_API_KEY
docker compose up -d db           # Postgres + pgvector on :5432
npm run dev                       # API on :3000 (migrations run on boot), web on :5173 with /api proxied
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (chunker, parsers, Gemini client) and API tests with a mocked LLM and embedder |
| `npm run typecheck` | Type-checks the server and the web app |
| `npm run build` | Builds `web/dist` and `server/dist` |
| `npm start` | Runs the built server, which also serves `web/dist` |

Tests need no database or API key.

## API

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/api/health` | `200 {status:"ok",db:"up"}` or `503` |
| `GET` | `/api/documents` | `{documents: [...]}` |
| `POST` | `/api/documents` | multipart field `file`. Returns `201 {document}`. Errors: `413` too big, `415` wrong type, `422` no text |
| `DELETE` | `/api/documents/:id` | `204`, `404` |
| `POST` | `/api/chat` | `{question, documentIds[]}` returns `{answer, sources:[{n, documentName, chunkIndex, snippet, score}]}`. Returns `429` when rate limited |

Errors are always `{ "error": "message" }`.

## Configuration

See [`.env.example`](.env.example). Key settings:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | Postgres with the `vector` extension available |
| `GEMINI_API_KEY` | none (required) | |
| `GEMINI_CHAT_MODELS` | `gemini-flash-lite-latest,gemini-flash-latest,gemini-3.8-flash` | Comma-separated. Tried in order on 503/429/404 |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | |
| `EMBED_DIM` | `768` | Must match `vector(768)` in the migration |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `800` / `100` | characters |
| `TOP_K` | `5` | |
| `CHAT_RATE_LIMIT_PER_MIN` | `20` | per IP |
| `MAX_UPLOAD_MB` | `5` | |

## Project layout

```
server/src
  app.ts            Express app factory (routes, rate limit, error mapping, static files)
  index.ts          Wiring: config → pool → migrations → app
  config.ts         zod-validated env
  ai/               Embedder / ChatModel interfaces + Gemini REST clients
  db/               pool, migration runner, Store interface + pg implementation
  migrations/       plain .sql files
  rag/              chunker, parsers, answer builder (prompt + citations)
server/test         Vitest + supertest
web/src             one-page React UI
```

## Deploy (Render + Neon)

`render.yaml` is a Blueprint for one Docker web service. Postgres runs on [Neon](https://neon.tech)'s free tier, which supports pgvector and doesn't expire. Render's free Postgres is limited to one per workspace and expires after 30 days.

1. Create a Neon project and copy its connection string (`postgresql://…?sslmode=require`).
2. Render Dashboard → **New → Blueprint** → select this repo.
3. Enter `DATABASE_URL` (the Neon string) and `GEMINI_API_KEY` when prompted.
4. Render builds the Dockerfile. On boot, migrations create the `vector` extension and the tables. The health check uses `/api/health`.

On the free tier the service sleeps when idle, so the first request takes about 30 s.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, tests and build, then a Docker image build, on every push to `main` and on every PR.

See [DECISIONS.md](DECISIONS.md) for design choices and trade-offs.

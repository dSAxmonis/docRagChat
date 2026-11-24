import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api, type DocumentInfo, type Source } from './api'

const MAX_MB = 5
const ACCEPT = '.pdf,.txt,.md,.markdown'

interface Message {
  role: 'user' | 'assistant'
  text: string
  sources?: Source[]
  error?: boolean
}

/** Render "[1]" style citations as small accent chips. */
function withCitations(text: string): ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) =>
    /^\[\d+\]$/.test(part) ? (
      <sup key={i} className="cite">
        {part.slice(1, -1)}
      </sup>
    ) : (
      part
    ),
  )
}

const PaperclipIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5" />
  </svg>
)

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

export default function App() {
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .listDocuments()
      .then((list) => {
        setDocs(list)
        setSelected(new Set(list.map((d) => d.id)))
      })
      .catch((e: Error) => setStatus(e.message))
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, asking])

  async function onUpload(file: File | undefined) {
    if (!file) return
    if (fileInput.current) fileInput.current.value = ''
    if (file.size > MAX_MB * 1024 * 1024) return setStatus(`${file.name} is larger than ${MAX_MB} MB`)
    setUploading(true)
    setStatus(`Reading ${file.name}…`)
    try {
      const doc = await api.uploadDocument(file)
      setDocs((d) => [doc, ...d])
      setSelected((s) => new Set(s).add(doc.id))
      setStatus(`Added ${doc.name}`)
    } catch (e) {
      setStatus(`Upload failed: ${(e as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  async function onDelete(doc: DocumentInfo) {
    if (!confirm(`Delete ${doc.name}?`)) return
    try {
      await api.deleteDocument(doc.id)
      setDocs((d) => d.filter((x) => x.id !== doc.id))
      setSelected((s) => {
        const next = new Set(s)
        next.delete(doc.id)
        return next
      })
    } catch (e) {
      setStatus(`Delete failed: ${(e as Error).message}`)
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function onAsk(e: FormEvent) {
    e.preventDefault()
    const q = question.trim()
    if (!q || asking || selected.size === 0) return
    setQuestion('')
    setMessages((m) => [...m, { role: 'user', text: q }])
    setAsking(true)
    try {
      const res = await api.chat(q, [...selected])
      setMessages((m) => [...m, { role: 'assistant', text: res.answer, sources: res.sources }])
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: (err as Error).message, error: true }])
    } finally {
      setAsking(false)
    }
  }

  const canAsk = selected.size > 0 && !asking

  return (
    <div className="shell">
      <header className="top">
        <span className="orb" aria-hidden />
        <div>
          <strong>DocRAG</strong>
          <small>Chat with your documents</small>
        </div>
      </header>

      <section className="docs" aria-label="Documents">
        <button className="doc add" onClick={() => fileInput.current?.click()} disabled={uploading}>
          <span className="spark">+</span>
          <span>{uploading ? 'Uploading…' : 'Add document'}</span>
          <small>PDF, TXT, MD · {MAX_MB} MB</small>
        </button>
        {docs.map((d) => (
          <label key={d.id} className={`doc ${selected.has(d.id) ? 'on' : ''}`} title={d.name}>
            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
            <span className="spark" aria-hidden>
              ✦
            </span>
            <span className="name">{d.name}</span>
            <small>
              {(d.sizeBytes / 1024).toFixed(0)} KB · {d.chunkCount} {d.chunkCount === 1 ? 'chunk' : 'chunks'}
            </small>
            <button
              className="del"
              aria-label={`Delete ${d.name}`}
              onClick={(e) => {
                e.preventDefault()
                onDelete(d)
              }}
            >
              ×
            </button>
          </label>
        ))}
      </section>
      {status && (
        <p className="status" role="status">
          {status}
        </p>
      )}

      <main className="chat">
        {messages.length === 0 ? (
          <h1 className="hero">
            What are we
            <br />
            reading today?
          </h1>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="bubble user">
                {m.text}
              </div>
            ) : (
              <div key={i} className="reply">
                <span className="orb sm" aria-hidden />
                <div className={`bubble bot ${m.error ? 'err' : ''}`}>
                  <p>{withCitations(m.text)}</p>
                  {m.sources && m.sources.length > 0 && (
                    <details>
                      <summary>{m.sources.length} sources</summary>
                      <ol>
                        {m.sources.map((s) => (
                          <li key={s.n}>
                            <span className="cite">{s.n}</span> <b>{s.documentName}</b> · chunk {s.chunkIndex + 1} ·{' '}
                            {Math.round(s.score * 100)}% match
                            <blockquote>{s.snippet}</blockquote>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </div>
            ),
          )
        )}
        {asking && <p className="working">Reading your documents…</p>}
        <div ref={bottom} />
      </main>

      <form className="composer" onSubmit={onAsk}>
        <button
          type="button"
          className="icon"
          aria-label="Upload document"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
        >
          <PaperclipIcon />
        </button>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={selected.size ? 'Ask about your documents' : 'Add or select a document first'}
          disabled={selected.size === 0}
          maxLength={2000}
          aria-label="Question"
        />
        <button className="send" aria-label="Send" disabled={!canAsk || !question.trim()}>
          <SendIcon />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => onUpload(e.target.files?.[0])}
        />
      </form>
    </div>
  )
}

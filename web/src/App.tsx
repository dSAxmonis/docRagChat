import { useEffect, useState, type FormEvent } from 'react'
import { api, type DocumentInfo, type Source } from './api'

const MAX_MB = 5
const ACCEPT = '.pdf,.txt,.md,.markdown'

interface Message {
  role: 'user' | 'assistant'
  text: string
  sources?: Source[]
  error?: boolean
}

export default function App() {
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    api
      .listDocuments()
      .then((list) => {
        setDocs(list)
        setSelected(new Set(list.map((d) => d.id)))
      })
      .catch((e: Error) => setStatus(e.message))
  }, [])

  async function onUpload(file: File | undefined, input: HTMLInputElement) {
    if (!file) return
    input.value = ''
    if (file.size > MAX_MB * 1024 * 1024) return setStatus(`${file.name} is larger than ${MAX_MB} MB`)
    setUploading(true)
    setStatus(`Uploading ${file.name}…`)
    try {
      const doc = await api.uploadDocument(file)
      setDocs((d) => [doc, ...d])
      setSelected((s) => new Set(s).add(doc.id))
      setStatus(`Added ${doc.name} (${doc.chunkCount} chunks)`)
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

  return (
    <main>
      <h1>Document Chat</h1>

      <section>
        <h2>Documents</h2>
        <label>
          Upload PDF, TXT or MD (max {MAX_MB} MB):{' '}
          <input
            type="file"
            accept={ACCEPT}
            disabled={uploading}
            onChange={(e) => onUpload(e.target.files?.[0], e.target)}
          />
        </label>
        <p role="status">{status}</p>
        {docs.length === 0 ? (
          <p>No documents yet.</p>
        ) : (
          <ul>
            {docs.map((d) => (
              <li key={d.id}>
                <label>
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} /> {d.name}{' '}
                  <small>
                    ({(d.sizeBytes / 1024).toFixed(0)} KB, {d.chunkCount} chunks)
                  </small>
                </label>{' '}
                <button onClick={() => onDelete(d)}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Chat</h2>
        {messages.map((m, i) => (
          <article key={i}>
            <strong>{m.role === 'user' ? 'You' : 'Assistant'}:</strong>
            <p style={{ whiteSpace: 'pre-wrap' }}>{m.text}</p>
            {m.sources && m.sources.length > 0 && (
              <details>
                <summary>Sources ({m.sources.length})</summary>
                <ol>
                  {m.sources.map((s) => (
                    <li key={s.n} value={s.n}>
                      <strong>{s.documentName}</strong> · chunk {s.chunkIndex + 1} · score {s.score}
                      <blockquote>{s.snippet}</blockquote>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </article>
        ))}
        {asking && <p>Thinking…</p>}
        <form onSubmit={onAsk}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={selected.size ? 'Ask about the selected documents' : 'Select at least one document'}
            disabled={selected.size === 0}
            maxLength={2000}
            aria-label="Question"
          />
          <button disabled={asking || !question.trim() || selected.size === 0}>Ask</button>
        </form>
      </section>
    </main>
  )
}

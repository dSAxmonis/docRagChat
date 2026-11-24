export interface DocumentInfo {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  chunkCount: number
  createdAt: string
}

export interface Source {
  n: number
  documentId: string
  documentName: string
  chunkIndex: number
  snippet: string
  score: number
}

export interface ChatResponse {
  answer: string
  sources: Source[]
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const api = {
  listDocuments: () => call<{ documents: DocumentInfo[] }>('/api/documents').then((r) => r.documents),

  uploadDocument: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return call<{ document: DocumentInfo }>('/api/documents', { method: 'POST', body: form }).then((r) => r.document)
  },

  deleteDocument: (id: string) => call<void>(`/api/documents/${id}`, { method: 'DELETE' }),

  chat: (question: string, documentIds: string[]) =>
    call<ChatResponse>('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, documentIds }),
    }),
}

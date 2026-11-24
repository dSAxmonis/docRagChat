// pdf-parse's package entry runs a debug harness when imported from ESM, so import the library file directly.
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

export type DocKind = 'pdf' | 'txt' | 'md'

export class UnsupportedFileError extends Error {}
export class EmptyDocumentError extends Error {}

const ALLOWED_MIME: Record<DocKind, string[]> = {
  pdf: ['application/pdf', 'application/x-pdf'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
}
// Browsers often send this when the OS has no MIME mapping (common for .md)
const GENERIC_MIME = 'application/octet-stream'

export const MIME_FOR_KIND: Record<DocKind, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
}

/** Decide the document kind from extension + declared MIME type, rejecting anything else. */
export function detectKind(filename: string, mimeType: string): DocKind {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const kind = ext === 'pdf' || ext === 'txt' || ext === 'md' ? ext : ext === 'markdown' ? 'md' : undefined
  if (!kind) throw new UnsupportedFileError('Only .pdf, .txt and .md files are supported')
  const mime = mimeType.split(';')[0].trim().toLowerCase()
  if (mime !== GENERIC_MIME && !ALLOWED_MIME[kind].includes(mime)) {
    throw new UnsupportedFileError(`File type ${mime || 'unknown'} does not match .${ext}`)
  }
  return kind
}

/** Extract plain text from an uploaded buffer. */
export async function extractText(buffer: Buffer, kind: DocKind): Promise<string> {
  let text: string
  if (kind === 'pdf') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new UnsupportedFileError('File is not a valid PDF')
    }
    try {
      // Copy into a standalone array: small Node Buffers are slices of a shared pool, and the
      // bundled pdf.js reads the whole underlying ArrayBuffer, ignoring the slice offset.
      text = (await pdfParse(new Uint8Array(buffer))).text
    } catch {
      throw new UnsupportedFileError('Could not read PDF (it may be encrypted or corrupted)')
    }
  } else {
    if (buffer.includes(0)) throw new UnsupportedFileError('File looks binary, not text')
    text = buffer.toString('utf8').replace(/^﻿/, '')
  }
  if (!text.trim()) {
    throw new EmptyDocumentError(
      kind === 'pdf' ? 'No extractable text found (scanned PDFs are not supported)' : 'File is empty',
    )
  }
  return text
}

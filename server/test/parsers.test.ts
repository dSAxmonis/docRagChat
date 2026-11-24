import { describe, expect, it } from 'vitest'
import { detectKind, EmptyDocumentError, extractText, UnsupportedFileError } from '../src/rag/parsers.js'
import { makePdf } from './helpers/pdf.js'

describe('detectKind', () => {
  it('accepts supported extensions with matching or generic MIME types', () => {
    expect(detectKind('a.PDF', 'application/pdf')).toBe('pdf')
    expect(detectKind('notes.txt', 'text/plain; charset=utf-8')).toBe('txt')
    expect(detectKind('readme.md', 'text/markdown')).toBe('md')
    expect(detectKind('readme.md', 'application/octet-stream')).toBe('md')
    expect(detectKind('readme.markdown', 'text/plain')).toBe('md')
  })

  it('rejects other extensions and mismatched MIME types', () => {
    expect(() => detectKind('a.docx', 'application/msword')).toThrow(UnsupportedFileError)
    expect(() => detectKind('noext', 'text/plain')).toThrow(UnsupportedFileError)
    expect(() => detectKind('a.pdf', 'text/plain')).toThrow(UnsupportedFileError)
    expect(() => detectKind('a.txt', 'image/png')).toThrow(UnsupportedFileError)
  })
})

describe('extractText', () => {
  it('reads utf-8 text and strips a BOM', async () => {
    expect(await extractText(Buffer.from('﻿héllo'), 'txt')).toBe('héllo')
  })

  it('extracts text from a PDF', async () => {
    const text = await extractText(makePdf(['Alpha line', 'Beta line']), 'pdf')
    expect(text).toContain('Alpha line')
    expect(text).toContain('Beta line')
  })

  it('rejects a fake PDF, binary text and empty files', async () => {
    await expect(extractText(Buffer.from('not a pdf'), 'pdf')).rejects.toThrow(UnsupportedFileError)
    await expect(extractText(Buffer.from([0x61, 0x00, 0x62]), 'txt')).rejects.toThrow(UnsupportedFileError)
    await expect(extractText(Buffer.from('  \n '), 'md')).rejects.toThrow(EmptyDocumentError)
  })
})

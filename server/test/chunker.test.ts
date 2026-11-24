import { describe, expect, it } from 'vitest'
import { chunkText, normalizeText } from '../src/rag/chunker.js'

const words = (s: string) => s.split(/\s+/).filter(Boolean)

const paragraph = (n: number, label: string) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i} of ${label} talks about retrieval.`).join(' ')

describe('normalizeText', () => {
  it('normalises line endings, trailing spaces and blank-line runs', () => {
    expect(normalizeText('a  \r\nb\r\rc\n\n\n\n\nd  ')).toBe('a\nb\n\nc\n\nd')
  })
})

describe('chunkText', () => {
  const opts = { size: 200, overlap: 40 }

  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkText('', opts)).toEqual([])
    expect(chunkText('   \n\n\t  ', opts)).toEqual([])
  })

  it('returns a single trimmed chunk when text fits', () => {
    expect(chunkText('  Hello world.  ', opts)).toEqual(['Hello world.'])
  })

  it('never produces a chunk longer than size', () => {
    const text = [paragraph(12, 'A'), paragraph(7, 'B'), 'x'.repeat(950), paragraph(20, 'C')].join('\n\n')
    const chunks = chunkText(text, opts)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(opts.size)
  })

  it('keeps every word of the input, in order', () => {
    const text = [paragraph(10, 'A'), paragraph(10, 'B')].join('\n\n')
    const chunks = chunkText(text, { size: 150, overlap: 0 })
    expect(chunks.flatMap(words)).toEqual(words(text))
  })

  it('repeats trailing context at the start of the next chunk', () => {
    const chunks = chunkText(paragraph(20, 'A'), opts)
    expect(chunks.length).toBeGreaterThan(2)
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = words(chunks[i - 1]).slice(-2).join(' ')
      expect(chunks[i]).toContain(prevTail)
    }
  })

  it('does not overlap when overlap is 0', () => {
    const text = paragraph(20, 'A')
    const chunks = chunkText(text, { size: 120, overlap: 0 })
    expect(chunks.join(' ').length).toBeLessThanOrEqual(text.length + chunks.length)
  })

  it('prefers paragraph boundaries over cutting mid-paragraph', () => {
    const a = paragraph(3, 'A')
    const b = paragraph(3, 'B')
    expect(a.length + b.length).toBeGreaterThan(opts.size)
    expect(chunkText(`${a}\n\n${b}`, { size: opts.size, overlap: 0 })).toEqual([a, b])
  })

  it('splits long paragraphs at sentence boundaries', () => {
    const chunks = chunkText(paragraph(10, 'A'), { size: 120, overlap: 0 })
    for (const c of chunks) expect(c.endsWith('.')).toBe(true)
  })

  it('hard-cuts a single token longer than size', () => {
    const token = 'y'.repeat(450)
    const chunks = chunkText(token, opts)
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50])
    expect(chunks.join('')).toBe(token)
  })

  it('handles markdown structure as plain text boundaries', () => {
    const md = `# Title\n\n${paragraph(5, 'intro')}\n\n## Section\n\n- item one\n- item two\n\n${paragraph(5, 'body')}`
    const chunks = chunkText(md, opts)
    expect(chunks[0].startsWith('# Title')).toBe(true)
    expect(chunks.some((c) => c.includes('- item one\n- item two'))).toBe(true)
  })

  it('is deterministic', () => {
    const text = paragraph(30, 'A')
    expect(chunkText(text, opts)).toEqual(chunkText(text, opts))
  })

  it('rejects invalid options', () => {
    expect(() => chunkText('x', { size: 0, overlap: 0 })).toThrow()
    expect(() => chunkText('x', { size: 100, overlap: 100 })).toThrow()
    expect(() => chunkText('x', { size: 100, overlap: -1 })).toThrow()
  })
})

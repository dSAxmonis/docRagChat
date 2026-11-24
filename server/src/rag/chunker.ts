export interface ChunkOptions {
  /** Maximum characters per chunk. */
  size: number
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlap: number
}

/**
 * Split boundaries from coarsest to finest. Each regex is a zero-width lookbehind,
 * so the separator stays attached to the left piece and joining pieces restores the text.
 */
const SEPARATORS: RegExp[] = [
  /(?<=\n\n)/, // paragraphs
  /(?<=\n)/, // lines
  /(?<=[.!?]\s)/, // sentences
  /(?<=\s)/, // words
]

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Break text into pieces that are each at most `size` chars, using the coarsest boundary that works. */
function splitIntoPieces(text: string, size: number, level = 0): string[] {
  if (text.length <= size) return [text]
  if (level >= SEPARATORS.length) {
    // No natural boundary left (e.g. a very long token): hard cut.
    const out: string[] = []
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
    return out
  }
  const parts = text.split(SEPARATORS[level]).filter((p) => p.length > 0)
  if (parts.length === 1) return splitIntoPieces(text, size, level + 1)
  return parts.flatMap((p) => splitIntoPieces(p, size, level + 1))
}

/**
 * Recursive character chunker: pieces at natural boundaries are packed greedily into
 * chunks of at most `size` chars, and each new chunk starts with up to `overlap` chars
 * of whole pieces carried over from the end of the previous one.
 */
export function chunkText(text: string, { size, overlap }: ChunkOptions): string[] {
  if (!Number.isInteger(size) || size <= 0) throw new Error('size must be a positive integer')
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error('overlap must be a non-negative integer smaller than size')
  }

  const normalized = normalizeText(text)
  if (!normalized) return []

  const pieces = splitIntoPieces(normalized, size)
  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0
  // True once `current` holds a piece that has not been emitted yet (not just carried-over overlap)
  let hasNew = false

  const flush = () => {
    const chunk = current.join('').trim()
    if (chunk) chunks.push(chunk)
  }

  for (const piece of pieces) {
    if (currentLen + piece.length > size && hasNew) {
      flush()
      // Carry whole trailing pieces into the next chunk, up to `overlap` chars.
      const carry: string[] = []
      let carryLen = 0
      for (let i = current.length - 1; i >= 0; i--) {
        if (carryLen + current[i].length > overlap) break
        carry.unshift(current[i])
        carryLen += current[i].length
      }
      current = carry
      currentLen = carryLen
      hasNew = false
    }
    // Drop carried context from the front if it would push this piece over the limit.
    while (current.length > 0 && currentLen + piece.length > size) {
      currentLen -= current.shift()!.length
    }
    current.push(piece)
    currentLen += piece.length
    hasNew = true
  }
  if (hasNew) flush()
  return chunks
}

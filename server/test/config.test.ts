import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = { DATABASE_URL: 'postgres://u:p@localhost/db', GEMINI_API_KEY: 'k' }

describe('loadConfig', () => {
  it('applies defaults and parses the chat model list', () => {
    const c = loadConfig(base)
    expect(c.PORT).toBe(3000)
    expect(c.DATABASE_URL_UNPOOLED).toBeUndefined()
    expect(c.GEMINI_CHAT_MODELS.length).toBeGreaterThan(0)
    expect(loadConfig({ ...base, GEMINI_CHAT_MODELS: 'a, b ,' }).GEMINI_CHAT_MODELS).toEqual(['a', 'b'])
  })

  it('treats an empty unpooled URL as unset and accepts a real one', () => {
    expect(loadConfig({ ...base, DATABASE_URL_UNPOOLED: '' }).DATABASE_URL_UNPOOLED).toBeUndefined()
    expect(loadConfig({ ...base, DATABASE_URL_UNPOOLED: 'postgres://direct/db' }).DATABASE_URL_UNPOOLED).toBe(
      'postgres://direct/db',
    )
  })

  it('trusts 3 proxy hops on Render unless overridden', () => {
    expect(loadConfig(base).TRUST_PROXY_HOPS).toBe(0)
    expect(loadConfig({ ...base, RENDER: 'true' }).TRUST_PROXY_HOPS).toBe(3)
    expect(loadConfig({ ...base, RENDER: 'true', TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1)
  })

  it('rejects missing secrets and bad chunk settings', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*GEMINI_API_KEY/)
    expect(() => loadConfig({ ...base, CHUNK_SIZE: '200', CHUNK_OVERLAP: '200' })).toThrow(/CHUNK_OVERLAP/)
  })
})

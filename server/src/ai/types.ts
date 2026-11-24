export interface Embedder {
  /** Embeds document chunks for storage. Output order matches input order. */
  embedDocuments(texts: string[]): Promise<number[][]>
  /** Embeds a user question for similarity search. */
  embedQuery(text: string): Promise<number[]>
}

export interface ChatModel {
  generate(input: { system: string; prompt: string }): Promise<string>
}

/** Raised when an upstream AI provider fails, so the API can answer 502/503 instead of 500. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

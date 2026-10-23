import type { RAGClassificationResponse, RAGHealthResponse } from '../hooks/useLiveDetection';

/** Nearest real dialogues from the RAG vector store. Optional: null when the store is unavailable. */
export async function fetchRag(text: string, topK = 3): Promise<RAGClassificationResponse | null> {
  try {
    const res = await fetch('/rag/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, top_k: topK, include_retrieved_examples: true }),
    });
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.debug('RAG query skipped:', err);
    return null;
  }
}

export async function fetchRagHealth(): Promise<RAGHealthResponse | null> {
  try {
    const res = await fetch('/rag/health', { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

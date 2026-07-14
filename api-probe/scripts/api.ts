import { apiBase } from '../src/config.js';

/** Minimal Bot API caller. Returns the parsed `result` or throws on `ok:false`. */
export async function callApi<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.error_code ?? '?'} ${json.description ?? 'unknown error'}`);
  }
  return json.result as T;
}

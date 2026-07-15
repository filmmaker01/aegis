/**
 * Lightweight in-process error monitoring for the webhook and media worker.
 * Dependency-free counters exposed via /ready. If SENTRY_DSN is set, wire a real
 * error tracker here (kept out of the dependency tree until actually needed).
 * Never records file bytes, tokens, or personal data — counts and timestamps only.
 */
export interface Metrics {
  webhookErrors: number
  mediaFailures: number
  notifyFailures: number
  lastErrorAt: string | null
  startedAt: string
}

const metrics: Metrics = {
  webhookErrors: 0,
  mediaFailures: 0,
  notifyFailures: 0,
  lastErrorAt: null,
  startedAt: new Date().toISOString(),
}

function touch(): void {
  metrics.lastErrorAt = new Date().toISOString()
}

export function recordWebhookError(): void {
  metrics.webhookErrors++
  touch()
}

export function recordMediaFailure(): void {
  metrics.mediaFailures++
  touch()
}

export function recordNotifyFailure(): void {
  metrics.notifyFailures++
  touch()
}

export function metricsSnapshot(): Metrics {
  return { ...metrics }
}

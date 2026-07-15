import type { MediaType } from '../domain/types'

export type MediaDownloadStatus = 'pending' | 'downloading' | 'stored' | 'failed'

/** A media item awaiting download. */
export interface PendingMediaJob {
  mediaId: string
  connectionId: string
  tgChatId: number
  tgMessageId: number
  type: MediaType
  tgFileId: string
  attempts: number
}

/** A stored media item ready to send back to the owner on deletion. */
export interface StoredMediaRef {
  mediaId: string
  type: MediaType
  storageKey: string
  fileName?: string | null
  mimeType?: string | null
}

export interface MediaStoredMeta {
  storageKey: string
  checksum: string
  sizeBytes?: number
  mimeType?: string
  fileName?: string
}

/** Sentinel attempt count that permanently excludes a media row from retries. */
export const PERMANENT_FAILURE_ATTEMPTS = 9999

export interface MediaRepository {
  /** Media in state pending, or failed with attempts < maxAttempts (retryable). */
  listPendingMedia(limit: number, maxAttempts: number): Promise<PendingMediaJob[]>

  /**
   * Atomically move a media row pending|failed -> downloading and increment
   * attempts. Returns true only for the caller that won the claim (idempotency).
   */
  claimMediaDownload(mediaId: string): Promise<boolean>

  markMediaStored(mediaId: string, meta: MediaStoredMeta): Promise<void>

  /** Mark failed. retryable=false sets a sentinel so it is never retried (e.g. too large). */
  markMediaFailed(mediaId: string, reason: string, retryable: boolean): Promise<void>

  /** Stored media for a message (only state=stored), used when sending on deletion. */
  getStoredMediaForMessage(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<StoredMediaRef[]>
}

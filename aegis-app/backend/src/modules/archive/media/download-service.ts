import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'

import { recordMediaFailure } from '../../../monitoring'
import type { TelegramFileClient } from '../../telegram/file-client'
import type { MediaRepository, PendingMediaJob } from '../application/media-ports'
import type { MediaStorage } from './storage'

export interface MediaDownloadConfig {
  /** Max bytes to download (Bot API caps ~20MB without a local API server). */
  maxBytes: number
  /** Retry attempts for transient failures before giving up. */
  maxAttempts: number
  /** Batch size per processPending sweep. */
  batchSize: number
}

export const DEFAULT_MEDIA_CONFIG: MediaDownloadConfig = {
  maxBytes: 20 * 1024 * 1024,
  maxAttempts: 3,
  batchSize: 25,
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

/**
 * Downloads media on arrival and stores it. Idempotent (claim per media row),
 * with limited retry. Downloads into an in-memory buffer bounded by maxBytes —
 * no temp files are written, so there is nothing to clean up on the download path.
 * Never logs file bytes, tokens, storage keys, or personal data.
 */
export class MediaDownloadService {
  private readonly cfg: MediaDownloadConfig

  constructor(
    private readonly repo: MediaRepository,
    private readonly fileClient: TelegramFileClient,
    private readonly storage: MediaStorage,
    config: Partial<MediaDownloadConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_MEDIA_CONFIG, ...config }
  }

  /** Process a batch of pending/retryable media. Safe to call repeatedly. */
  async processPending(): Promise<{ processed: number; stored: number; failed: number }> {
    const jobs = await this.repo.listPendingMedia(this.cfg.batchSize, this.cfg.maxAttempts)
    let stored = 0
    let failed = 0
    for (const job of jobs) {
      const ok = await this.processJob(job)
      if (ok === 'stored') stored++
      else if (ok === 'failed') {
        failed++
        recordMediaFailure()
      }
    }
    return { processed: jobs.length, stored, failed }
  }

  private async processJob(job: PendingMediaJob): Promise<'stored' | 'failed' | 'skipped'> {
    if (!(await this.repo.claimMediaDownload(job.mediaId))) return 'skipped'
    try {
      const info = await this.fileClient.getFile(job.tgFileId)
      if (!info) {
        await this.repo.markMediaFailed(job.mediaId, 'getFile returned no file_path', true)
        console.error(`[media] media_id=${job.mediaId} type=${job.type} result=failed reason=getfile`)
        return 'failed'
      }
      if (info.fileSize && info.fileSize > this.cfg.maxBytes) {
        await this.repo.markMediaFailed(job.mediaId, `too_large:${info.fileSize}`, false)
        console.error(`[media] media_id=${job.mediaId} type=${job.type} result=failed reason=too_large`)
        return 'failed'
      }
      const bytes = await this.fileClient.downloadToBuffer(info.filePath)
      if (bytes.length > this.cfg.maxBytes) {
        await this.repo.markMediaFailed(job.mediaId, `too_large:${bytes.length}`, false)
        return 'failed'
      }
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const fileName = sanitize(basename(info.filePath))
      const ext = extname(fileName).toLowerCase()
      const mimeType = MIME_BY_EXT[ext]
      const key = `media/${sanitize(job.connectionId)}/${job.tgMessageId}/${job.mediaId}-${fileName}`
      await this.storage.put(key, bytes, mimeType)
      await this.repo.markMediaStored(job.mediaId, {
        storageKey: key,
        checksum,
        sizeBytes: bytes.length,
        mimeType,
        fileName,
      })
      console.log(`[media] media_id=${job.mediaId} type=${job.type} result=stored bytes=${bytes.length}`)
      return 'stored'
    } catch (err) {
      await this.repo.markMediaFailed(job.mediaId, `error:${(err as Error).name}`, true)
      console.error(`[media] media_id=${job.mediaId} type=${job.type} result=failed reason=exception`)
      return 'failed'
    }
  }
}

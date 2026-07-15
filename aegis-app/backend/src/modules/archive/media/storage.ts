import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import type { AppEnv } from '../../../env'
import { assertSafeObjectKey, storageConfigFromEnv } from '../../../storage/service'

/**
 * Server-side blob storage for archived media. Distinct from the template's
 * presigned-URL StorageService (which targets browser uploads) — the media worker
 * downloads bytes from Telegram and later re-uploads them to Telegram, so it needs
 * direct put/get of bytes.
 */
export interface MediaStorage {
  readonly kind: 'local' | 's3'
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>
  get(key: string): Promise<Buffer>
}

/** Local disk storage — dev fallback, no cloud keys required. */
export class LocalDiskMediaStorage implements MediaStorage {
  readonly kind = 'local' as const
  constructor(private readonly baseDir: string) {}

  private pathFor(key: string): string {
    assertSafeObjectKey(key)
    return join(this.baseDir, key)
  }

  async put(key: string, bytes: Buffer, _contentType?: string): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key))
  }
}

/** S3-compatible storage (DigitalOcean Spaces / AWS S3 / Supabase S3), private objects. */
export class S3MediaStorage implements MediaStorage {
  readonly kind = 's3' as const
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    assertSafeObjectKey(key)
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ACL: 'private',
      }),
    )
  }

  async get(key: string): Promise<Buffer> {
    assertSafeObjectKey(key)
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const bytes = await res.Body?.transformToByteArray()
    if (!bytes) throw new Error(`media object not found: ${key}`)
    return Buffer.from(bytes)
  }
}

/**
 * Chooses storage from env: S3 when MEDIA_STORAGE=s3 or SPACES_* is configured and
 * not explicitly 'local'; otherwise local disk (MEDIA_LOCAL_DIR or ./.media).
 */
export function createMediaStorage(env: AppEnv): MediaStorage {
  const s3Config = storageConfigFromEnv(env)
  const wantsS3 = env.MEDIA_STORAGE === 's3' || (env.MEDIA_STORAGE !== 'local' && s3Config !== null)

  if (wantsS3) {
    if (!s3Config) {
      throw new Error('MEDIA_STORAGE=s3 but SPACES_* is not fully configured')
    }
    const s3 = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      // Path-style is required by Supabase Storage's S3 endpoint (and is also
      // accepted by AWS S3 / DO Spaces). Virtual-hosted style would resolve to a
      // non-existent `<bucket>.<host>` and fail.
      forcePathStyle: true,
      credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
    })
    return new S3MediaStorage(s3, s3Config.bucket)
  }

  const dir = env.MEDIA_LOCAL_DIR ? resolve(env.MEDIA_LOCAL_DIR) : resolve(process.cwd(), '.media')
  return new LocalDiskMediaStorage(dir)
}

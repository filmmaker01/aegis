import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { LocalDiskMediaStorage } from './storage'

const dir = mkdtempSync(join(tmpdir(), 'aegis-media-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('LocalDiskMediaStorage', () => {
  test('put then get round-trips bytes', async () => {
    const storage = new LocalDiskMediaStorage(dir)
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])
    await storage.put('media/conn/1/abc.jpg', bytes, 'image/jpeg')
    const back = await storage.get('media/conn/1/abc.jpg')
    expect(back.equals(bytes)).toBe(true)
  })

  test('rejects unsafe keys', async () => {
    const storage = new LocalDiskMediaStorage(dir)
    await expect(storage.put('/absolute/key', Buffer.from('x'))).rejects.toBeDefined()
  })
})

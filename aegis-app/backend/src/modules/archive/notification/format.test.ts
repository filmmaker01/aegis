import { describe, expect, test } from 'bun:test'

import {
  CALLBACK_DATA_LIMIT,
  MESSAGE_TEXT_LIMIT,
  batchCard,
  decodeCallback,
  deletedKeyboard,
  deletedTextCard,
  editedCard,
  encodeCallback,
  escapeHtml,
  formatTimestamp,
  historyKeyboard,
  historyView,
  mediaCaption,
  mediaLeadCard,
  pluralRu,
  splitText,
  truncate,
} from './format'

const at = new Date('2026-07-15T23:45:00Z')
const now = new Date('2026-07-15T23:50:00Z')

describe('escapeHtml', () => {
  test('escapes the entity-significant characters', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })
  test('neutralises injected HTML/Markdown so no tag survives', () => {
    const out = escapeHtml('<script>alert(1)</script> *bold* _x_')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })
})

describe('truncate', () => {
  test('leaves short text intact', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })
  test('adds ellipsis when cut and respects char count', () => {
    const out = truncate('abcdefghij', 5)
    expect([...out]).toHaveLength(5)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('splitText', () => {
  test('returns a single chunk for short text', () => {
    expect(splitText('short', 100)).toEqual(['short'])
  })
  test('splits long text into chunks within the limit', () => {
    const long = 'a '.repeat(3000) // 6000 chars
    const chunks = splitText(long, MESSAGE_TEXT_LIMIT)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(MESSAGE_TEXT_LIMIT)
  })
})

describe('pluralRu', () => {
  const forms: [string, string, string] = ['сообщение', 'сообщения', 'сообщений']
  test.each([
    [1, 'сообщение'],
    [2, 'сообщения'],
    [4, 'сообщения'],
    [5, 'сообщений'],
    [11, 'сообщений'],
    [21, 'сообщение'],
    [22, 'сообщения'],
    [100, 'сообщений'],
  ])('%i -> %s', (n, expected) => {
    expect(pluralRu(n as number, forms)).toBe(expected)
  })
})

describe('formatTimestamp', () => {
  test('same UTC day -> HH:MM', () => {
    expect(formatTimestamp(at, now)).toBe('23:45')
  })
  test('different day -> DD.MM · HH:MM', () => {
    expect(formatTimestamp(new Date('2026-07-10T08:03:00Z'), now)).toBe('10.07 · 08:03')
  })
})

describe('deletedTextCard', () => {
  test('archived card shows neutral header, peer and saved text', () => {
    const card = deletedTextCard({
      peer: { name: 'Roman', username: 'roman' },
      at,
      savedText: 'привет',
      archived: true,
      now,
    })
    expect(card).toContain('🗑 <b>Сообщение удалено</b>')
    expect(card).toContain('<b>Roman</b>')
    expect(card).toContain('@roman · 23:45')
    expect(card).toContain('привет')
    // Never claims who deleted.
    expect(card.toLowerCase()).not.toContain('удалил')
  })
  test('unarchived card is honest about missing copy', () => {
    const card = deletedTextCard({ peer: { name: 'Roman' }, at, archived: false, now })
    expect(card).toContain('Обнаружено удаление')
    expect(card).toContain('копия не сохранена')
  })
  test('escapes malicious saved text', () => {
    const card = deletedTextCard({ peer: { name: '<b>x' }, at, savedText: '<i>hi</i>', archived: true, now })
    expect(card).toContain('&lt;i&gt;hi&lt;/i&gt;')
    expect(card).toContain('&lt;b&gt;x')
  })
})

describe('editedCard', () => {
  test('shows before and after', () => {
    const card = editedCard({ peer: { name: 'Roman', username: 'roman' }, at, before: 'старое', after: 'новое', now })
    expect(card).toContain('✏️ <b>Сообщение изменено</b>')
    expect(card).toContain('<b>Было:</b>')
    expect(card).toContain('старое')
    expect(card).toContain('<b>Стало:</b>')
    expect(card).toContain('новое')
  })
})

describe('mediaLeadCard / mediaCaption', () => {
  test('lead card names the media and shows caption', () => {
    const card = mediaLeadCard({ peer: { name: 'Roman' }, at, types: ['photo'], caption: 'на пляже', archived: true, now })
    expect(card).toContain('Удалено сообщение с медиа')
    expect(card).toContain('фото')
    expect(card).toContain('на пляже')
  })
  test('caption is escaped and length-capped', () => {
    expect(mediaCaption('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;')
    expect(mediaCaption('')).toBeUndefined()
    expect(mediaCaption(null)).toBeUndefined()
    const long = mediaCaption('y'.repeat(5000))!
    expect([...long].length).toBeLessThanOrEqual(1024)
  })
})

describe('batchCard', () => {
  test('summarises count with correct plural and previews first few', () => {
    const card = batchCard({
      peer: { name: 'Roman' },
      count: 22,
      at,
      now,
      previews: [{ savedText: 'один' }, { mediaTypes: ['photo'] }, { savedText: 'три' }],
    })
    expect(card).toContain('Удалено 22 сообщения')
    expect(card).toContain('• один')
    expect(card).toContain('📎 фото')
    expect(card).toContain('…и ещё 19')
  })
})

describe('historyView', () => {
  test('renders versions with page indicator', () => {
    const view = historyView({
      versions: [
        { versionNo: 1, text: 'v1', at },
        { versionNo: 2, text: 'v2', at },
      ],
      page: 1,
      pageSize: 3,
      total: 2,
      now,
    })
    expect(view).toContain('История сообщения')
    expect(view).toContain('стр. 1/1')
    expect(view).toContain('<b>Версия 1</b>')
    expect(view).toContain('<b>Версия 2</b>')
  })
})

describe('callback_data codec', () => {
  test('round-trips action and parts', () => {
    const data = encodeCallback('history', '0197e2aa-1111-7000-8000-abcdef012345', 3)
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT)
    const { action, parts } = decodeCallback(data)
    expect(action).toBe('history')
    expect(parts).toEqual(['0197e2aa-1111-7000-8000-abcdef012345', '3'])
  })
  test('throws when data would exceed the Telegram limit', () => {
    expect(() => encodeCallback('restore', 'x'.repeat(70))).toThrow()
  })
})

describe('keyboards', () => {
  test('deleted keyboard omits Restore when not archived', () => {
    const kb = deletedKeyboard('e1', { hasHistory: true, archived: false })
    const flat = kb.inline_keyboard.flat().map((b) => b.text)
    expect(flat).not.toContain('Восстановить')
    expect(flat).toContain('История изменений')
    expect(flat).toContain('Открыть архив')
  })
  test('history keyboard shows only Next on first page of many', () => {
    const kb = historyKeyboard('e1', 1, 3)
    const flat = kb.inline_keyboard.flat().map((b) => b.text)
    expect(flat.some((t) => t.includes('Дальше'))).toBe(true)
    expect(flat.some((t) => t.includes('Назад'))).toBe(false)
  })
})

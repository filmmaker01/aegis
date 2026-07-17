import { describe, expect, test } from 'bun:test'

import type { Task } from '../domain/types'
import {
  CALLBACK_DATA_LIMIT,
  MESSAGE_TEXT_LIMIT,
  TIMEZONES,
  decodeCallback,
  encodeCallback,
  escapeHtml,
  formatWhen,
  mainMenuKeyboard,
  pluralRu,
  reminderKeyboard,
  whenKeyboard,
  calendarKeyboard,
  hourKeyboard,
  minuteKeyboard,
  splitText,
  taskDetailCard,
  taskDetailKeyboard,
  taskListCard,
  taskListKeyboard,
  timezoneCard,
  timezoneKeyboard,
  timezoneLabel,
  todayCard,
  truncate,
} from './format'

const MSK = 'Europe/Moscow'
const NOW = new Date('2026-07-17T09:00:00Z') // 12:00 MSK

const UUID = '00000000-0000-4000-8000-000000000001'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: UUID,
    telegramUserId: 42,
    title: 'Купить хлеб',
    status: 'active',
    remindAt: null,
    reminderState: 'pending',
    reminderAttempts: 0,
    reminderNextAttemptAt: null,
    reminderSentAt: null,
    reminderFailedReason: null,
    completedAt: null,
    createdAt: NOW,
    ...overrides,
  }
}

describe('escapeHtml', () => {
  test('escapes the characters Telegram HTML mode cares about', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })

  test('leaves ordinary text alone', () => {
    expect(escapeHtml('Купить хлеб')).toBe('Купить хлеб')
  })
})

describe('truncate', () => {
  test('leaves short text untouched', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })

  test('cuts with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
  })

  test('counts codepoints, not UTF-16 units', () => {
    expect(truncate('👍👍👍', 2)).toBe('👍…')
  })
})

describe('splitText', () => {
  test('keeps text within one chunk when it fits', () => {
    expect(splitText('short')).toEqual(['short'])
  })

  test('splits oversized text into limit-sized chunks', () => {
    const chunks = splitText('a '.repeat(3000), 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect([...chunk].length).toBeLessThanOrEqual(100)
  })

  test('never exceeds the Telegram message limit', () => {
    for (const chunk of splitText('я'.repeat(10_000))) {
      expect([...chunk].length).toBeLessThanOrEqual(MESSAGE_TEXT_LIMIT)
    }
  })
})

describe('pluralRu', () => {
  test('picks the Russian plural form', () => {
    const forms: [string, string, string] = ['задача', 'задачи', 'задач']
    expect(pluralRu(1, forms)).toBe('задача')
    expect(pluralRu(2, forms)).toBe('задачи')
    expect(pluralRu(5, forms)).toBe('задач')
    expect(pluralRu(11, forms)).toBe('задач')
    expect(pluralRu(21, forms)).toBe('задача')
  })
})

describe('formatWhen', () => {
  test('renders today/tomorrow/yesterday relative to the owner day', () => {
    expect(formatWhen(new Date('2026-07-17T16:00:00Z'), MSK, NOW)).toBe('сегодня, 19:00')
    expect(formatWhen(new Date('2026-07-18T06:00:00Z'), MSK, NOW)).toBe('завтра, 09:00')
    expect(formatWhen(new Date('2026-07-16T06:00:00Z'), MSK, NOW)).toBe('вчера, 09:00')
  })

  test('renders a far date with the month name', () => {
    expect(formatWhen(new Date('2026-12-25T11:30:00Z'), MSK, NOW)).toBe('25 дек, 14:30')
  })

  test('includes the year only when it differs', () => {
    expect(formatWhen(new Date('2027-01-05T06:00:00Z'), MSK, NOW)).toBe('5 янв 2027, 09:00')
  })

  test('uses calendar days, not 24h spans', () => {
    // 21:30 UTC is 00:30 MSK the next day -> "завтра", though only 12.5h away.
    expect(formatWhen(new Date('2026-07-17T21:30:00Z'), MSK, NOW)).toBe('завтра, 00:30')
  })
})

describe('callback_data codec', () => {
  test('round-trips an action with parts', () => {
    expect(decodeCallback(encodeCallback('snz', UUID, '15m'))).toEqual({
      action: 'snz',
      parts: [UUID, '15m'],
    })
  })

  test('every real payload fits Telegram 64-byte limit', () => {
    const payloads = [
      ...mainMenuKeyboard().inline_keyboard.flat(),
      ...whenKeyboard().inline_keyboard.flat(),
      ...calendarKeyboard(2026, 8, NOW, MSK).inline_keyboard.flat(),
      ...hourKeyboard(2026, 8, 15, NOW, MSK).inline_keyboard.flat(),
      ...minuteKeyboard(2026, 8, 15, 14, NOW, MSK).inline_keyboard.flat(),
      ...timezoneKeyboard().inline_keyboard.flat(),
      ...reminderKeyboard(UUID).inline_keyboard.flat(),
      ...taskDetailKeyboard(task()).inline_keyboard.flat(),
      ...taskListKeyboard([task()], MSK, NOW).inline_keyboard.flat(),
    ].map((b) => b.callback_data ?? '')

    for (const payload of payloads) {
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT)
    }
  })

  test('refuses to build an oversized payload rather than truncating it', () => {
    expect(() => encodeCallback('x', 'y'.repeat(CALLBACK_DATA_LIMIT))).toThrow('too long')
  })

  test('decoding junk yields an unknown action rather than throwing', () => {
    expect(decodeCallback('')).toEqual({ action: '', parts: [] })
  })
})

describe('keyboards', () => {
  test('the when-step offers presets, a calendar, none, and cancel', () => {
    const data = whenKeyboard().inline_keyboard.flat().map((b) => b.callback_data)
    expect(data).toEqual(['slot:30m', 'slot:1h', 'slot:evening', 'slot:morning', 'cal', 'slot:none', 'cancel'])
  })

  test('the reminder keyboard offers done / +15m / +1h / reschedule', () => {
    const data = reminderKeyboard(UUID).inline_keyboard.flat().map((b) => b.callback_data)
    expect(data).toEqual([`done:${UUID}`, `snz:${UUID}:15m`, `snz:${UUID}:1h`, `edittime:${UUID}`])
  })

  test('a completed task swaps done/snooze for an undo', () => {
    const data = taskDetailKeyboard(task({ status: 'done' })).inline_keyboard.flat().map((b) => b.callback_data)
    expect(data).toEqual([`reopen:${UUID}`, `edit:${UUID}`, `del:${UUID}`, 'list'])
  })

  test('every offered timezone is a real IANA zone', () => {
    for (const tz of TIMEZONES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz.id })).not.toThrow()
    }
  })
})

describe('the task list', () => {
  test('the buttons carry the tasks, so the card text does not repeat them', () => {
    const tasks = [task({ title: 'Купить хлеб', remindAt: new Date('2026-07-17T16:00:00Z') })]
    const card = taskListCard(tasks)
    const labels = taskListKeyboard(tasks, MSK, NOW).inline_keyboard.flat().map((b) => b.text)

    // The title appears exactly once in the UI — on its button.
    expect(card).not.toContain('Купить хлеб')
    expect(labels[0]).toContain('Купить хлеб')
    expect(labels[0]).toContain('сегодня, 19:00')
  })

  test('button labels escape nothing — they are plain text, never HTML', () => {
    // A title with markup must reach the button verbatim: Telegram renders button
    // labels literally, so escaping here would show the user "&lt;b&gt;".
    const labels = taskListKeyboard([task({ title: '<b>hi</b>' })], MSK, NOW).inline_keyboard.flat()
    expect(labels[0]!.text).toContain('<b>hi</b>')
  })

  test('a completed task is marked and shows no reminder time', () => {
    // Its reminder can never fire again, so promising a time would be a lie.
    const done = task({ status: 'done', remindAt: new Date('2026-07-17T16:00:00Z') })
    const label = taskListKeyboard([done], MSK, NOW).inline_keyboard.flat()[0]!.text
    expect(label).toContain('✅')
    expect(label).not.toContain('19:00')
  })

  test('the header summarises what is left, in Russian plural', () => {
    expect(taskListCard([task(), task({ id: 'b' })])).toContain('2 задачи в работе')
    expect(taskListCard([task({ status: 'done' })])).toContain('Всё сделано')
  })

  test('the empty list and empty today invite rather than report', () => {
    expect(taskListCard([])).toContain('Пока пусто')
    expect(todayCard([], MSK, NOW)).toContain('ничего не запланировано')
  })
})

describe('cards', () => {

  test('the detail card leads with the title and its reminder', () => {
    const card = taskDetailCard(task({ remindAt: new Date('2026-07-17T16:00:00Z') }), MSK, NOW)
    expect(card).toContain('Купить хлеб')
    expect(card).toContain('сегодня, 19:00')
  })

  test('the detail card says so when there is no reminder', () => {
    expect(taskDetailCard(task(), MSK, NOW)).toContain('Без напоминания')
  })

  test('a completed task shows when it was done, never a reminder that cannot fire', () => {
    const card = taskDetailCard(
      task({
        status: 'done',
        completedAt: new Date('2026-07-17T09:30:00Z'),
        // Still in the future, but the due scan only claims active tasks — so it
        // will never ring, and showing it would promise something impossible.
        remindAt: new Date('2026-07-17T16:00:00Z'),
      }),
      MSK,
      NOW,
    )
    expect(card).toContain('✅ Выполнено')
    expect(card).toContain('сегодня, 12:30')
    expect(card).not.toContain('19:00')
  })

  test('cards escape titles', () => {
    expect(taskDetailCard(task({ title: '<script>' }), MSK, NOW)).toContain('&lt;script&gt;')
  })
})

describe('timezoneLabel', () => {
  test('renders a human label, never the IANA id', () => {
    expect(timezoneLabel('Europe/Moscow')).toBe('Москва (UTC+3)')
    expect(timezoneLabel('Europe/Moscow')).not.toContain('Europe/')
  })

  test('falls back to a UTC offset for a zone we do not list', () => {
    expect(timezoneLabel('Asia/Tokyo', NOW)).toBe('UTC+9')
    expect(timezoneLabel('America/New_York', NOW)).toBe('UTC−4')
  })

  test('the settings card shows the label, not the raw zone', () => {
    const card = timezoneCard('Europe/Moscow', NOW)
    expect(card).toContain('Москва (UTC+3)')
    expect(card).not.toContain('Europe/Moscow')
  })
})

describe('calendar keyboards', () => {
  const NOW2 = new Date('2026-08-10T09:00:00Z') // 10 Aug, 12:00 MSK

  test('calendar has month nav, weekday header, and day buttons', () => {
    const kb = calendarKeyboard(2026, 8, NOW2, MSK)
    const flat = kb.inline_keyboard.flat()
    // nav arrows
    expect(flat.some((b) => b.callback_data === 'calnav:2026:7')).toBe(true)
    expect(flat.some((b) => b.callback_data === 'calnav:2026:9')).toBe(true)
    // a future day is pickable
    expect(flat.some((b) => b.callback_data === 'calday:2026:8:15')).toBe(true)
    // a past day (Aug 5, before Aug 10) is NOT pickable (noop)
    const aug5 = flat.find((b) => b.text === '·5')
    expect(aug5?.callback_data).toBe('noop')
    // today button + back
    expect(flat.some((b) => b.callback_data === 'calday:2026:8:10')).toBe(true)
    expect(flat.some((b) => b.callback_data === 'when')).toBe(true)
  })

  test('December calendar wraps the year in nav', () => {
    const flat = calendarKeyboard(2026, 12, NOW2, MSK).inline_keyboard.flat()
    expect(flat.some((b) => b.callback_data === 'calnav:2027:1')).toBe(true)
    expect(flat.some((b) => b.callback_data === 'calnav:2026:11')).toBe(true)
  })

  test('hour keyboard offers 24 hours plus manual entry', () => {
    const flat = hourKeyboard(2026, 8, 15, NOW2, MSK).inline_keyboard.flat()
    expect(flat.filter((b) => b.callback_data?.startsWith('calh:2026:8:15:'))).toHaveLength(24)
    expect(flat.some((b) => b.callback_data === 'calman:2026:8:15')).toBe(true)
  })

  test('minute keyboard offers 5-minute steps', () => {
    const flat = minuteKeyboard(2026, 8, 15, 14, NOW2, MSK).inline_keyboard.flat()
    const mins = flat.filter((b) => b.callback_data?.startsWith('calm:2026:8:15:14:'))
    expect(mins).toHaveLength(12) // :00 :05 … :55
    expect(mins[0]!.callback_data).toBe('calm:2026:8:15:14:0')
  })

  test('on today, past hours are not pickable', () => {
    // today = 10 Aug, 12:00 MSK -> hour 09 is past, 12 and 18 are ok
    const flat = hourKeyboard(2026, 8, 10, NOW2, MSK).inline_keyboard.flat()
    expect(flat.find((b) => b.text === '·09')?.callback_data).toBe('noop')
    expect(flat.some((b) => b.callback_data === 'calh:2026:8:10:18')).toBe(true)
  })
})

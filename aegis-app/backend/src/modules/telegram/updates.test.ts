import { describe, expect, test } from 'bun:test'

import {
  dispatchUpdate,
  toIncomingCallback,
  toIncomingMessage,
  type IncomingCallback,
  type IncomingMessage,
  type UpdateHandler,
} from './updates'

function recordingHandler(claimResult = true) {
  const messages: IncomingMessage[] = []
  const callbacks: IncomingCallback[] = []
  const claimed: number[] = []
  const handler: UpdateHandler = {
    async claim(updateId) {
      claimed.push(updateId)
      return claimResult
    },
    async onMessage(message) {
      messages.push(message)
    },
    async onCallback(callback) {
      callbacks.push(callback)
    },
  }
  return { handler, messages, callbacks, claimed }
}

const privateChat = { id: 42, type: 'private' }

describe('toIncomingMessage', () => {
  test('maps a private text message', () => {
    expect(
      toIncomingMessage({ message_id: 7, from: { id: 42 }, chat: privateChat, text: 'Купить хлеб' }),
    ).toEqual({ fromTgId: 42, chatId: 42, messageId: 7, text: 'Купить хлеб' })
  })

  test('ignores group chats — the planner is personal', () => {
    expect(
      toIncomingMessage({ message_id: 7, from: { id: 42 }, chat: { id: -100, type: 'group' }, text: 'hi' }),
    ).toBeNull()
  })

  test('ignores bots, missing sender, non-text and blank text', () => {
    expect(toIncomingMessage({ message_id: 1, from: { id: 1, is_bot: true }, chat: privateChat, text: 'x' })).toBeNull()
    expect(toIncomingMessage({ message_id: 1, chat: privateChat, text: 'x' })).toBeNull()
    expect(toIncomingMessage({ message_id: 1, from: { id: 1 }, chat: privateChat })).toBeNull()
    expect(toIncomingMessage({ message_id: 1, from: { id: 1 }, chat: privateChat, text: '   ' })).toBeNull()
  })
})

describe('toIncomingCallback', () => {
  test('maps a callback query', () => {
    expect(
      toIncomingCallback({
        id: 'cb1',
        from: { id: 42 },
        message: { message_id: 9, chat: privateChat },
        data: 'open:abc',
      }),
    ).toEqual({ id: 'cb1', fromTgId: 42, chatId: 42, messageId: 9, data: 'open:abc' })
  })

  test('rejects a callback without data or message', () => {
    expect(
      toIncomingCallback({ id: 'cb1', from: { id: 42 }, message: { message_id: 9, chat: privateChat } }),
    ).toBeNull()
    expect(toIncomingCallback({ id: 'cb1', from: { id: 42 }, data: 'x' })).toBeNull()
  })
})

describe('dispatchUpdate', () => {
  test('routes a message', async () => {
    const { handler, messages } = recordingHandler()
    const handled = await dispatchUpdate(
      { update_id: 1, message: { message_id: 7, from: { id: 42 }, chat: privateChat, text: '/new' } },
      handler,
    )
    expect(handled).toBe('message')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe('/new')
  })

  test('routes a callback query', async () => {
    const { handler, callbacks } = recordingHandler()
    const handled = await dispatchUpdate(
      {
        update_id: 2,
        callback_query: {
          id: 'cb',
          from: { id: 42 },
          message: { message_id: 9, chat: privateChat },
          data: 'list',
        },
      },
      handler,
    )
    expect(handled).toBe('callback_query')
    expect(callbacks[0]!.data).toBe('list')
  })

  test('skips an update whose id was already claimed (Telegram retry)', async () => {
    const { handler, messages } = recordingHandler(false)
    const handled = await dispatchUpdate(
      { update_id: 3, message: { message_id: 7, from: { id: 42 }, chat: privateChat, text: 'hi' } },
      handler,
    )
    expect(handled).toBe('duplicate')
    expect(messages).toHaveLength(0)
  })

  test('claims before doing any work', async () => {
    const { handler, claimed } = recordingHandler()
    await dispatchUpdate(
      { update_id: 11, message: { message_id: 1, from: { id: 42 }, chat: privateChat, text: 'x' } },
      handler,
    )
    expect(claimed).toEqual([11])
  })

  test('ignores an unknown update type and a malformed update', async () => {
    const { handler } = recordingHandler()
    expect(await dispatchUpdate({ update_id: 4, poll: {} }, handler)).toBe('ignored')
    expect(await dispatchUpdate({} as never, handler)).toBeNull()
  })

  test('a leftover business_* update is ignored, not an error', async () => {
    // The bot is still registered as a Business bot, and the webhook may still be
    // subscribed to these types until setWebhook is re-run. They must land softly
    // rather than 500 and make Telegram retry forever.
    const { handler, messages, callbacks } = recordingHandler()

    for (const update of [
      { update_id: 20, business_connection: { id: 'bc', user: { id: 1 }, user_chat_id: 1 } },
      {
        update_id: 21,
        business_message: { message_id: 1, business_connection_id: 'bc', chat: { id: 5 }, text: 'привет' },
      },
      {
        update_id: 22,
        edited_business_message: { message_id: 1, business_connection_id: 'bc', chat: { id: 5 }, text: 'правка' },
      },
      {
        update_id: 23,
        deleted_business_messages: { business_connection_id: 'bc', chat: { id: 5 }, message_ids: [1, 2] },
      },
    ]) {
      expect(await dispatchUpdate(update, handler)).toBe('ignored')
    }

    // Crucially, a business_message must NOT be mistaken for a planner command.
    expect(messages).toHaveLength(0)
    expect(callbacks).toHaveLength(0)
  })

  test('claims but does not deliver an unparseable message (e.g. a photo)', async () => {
    const { handler, messages } = recordingHandler()
    const handled = await dispatchUpdate(
      { update_id: 5, message: { message_id: 7, from: { id: 42 }, chat: privateChat } },
      handler,
    )
    expect(handled).toBe('message')
    expect(messages).toHaveLength(0)
  })
})

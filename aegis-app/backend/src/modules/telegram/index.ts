/**
 * Public API of the telegram module.
 *
 * Other modules must import from here rather than reaching into internal files,
 * so the Bot API surface stays swappable behind one boundary.
 */

export { TelegramBotClient } from './bot-client'
export type {
  BotCommand,
  InlineKeyboardMarkup,
  SendMessageOptions,
  SendResult,
} from './bot-client'

export { dispatchUpdate, toIncomingCallback, toIncomingMessage } from './updates'
export type { IncomingCallback, IncomingMessage, RawUpdate, UpdateHandler } from './updates'

export { createWebhookRoutes } from './transport/webhook-routes'
export type { WebhookRoutesOptions } from './transport/webhook-routes'

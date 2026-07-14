/**
 * Minimal, permissive types for raw Telegram updates.
 * The probe's whole point is to observe the REAL payloads, so every object
 * keeps an index signature — we never want the types to hide unexpected fields.
 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  [k: string]: unknown;
}

export interface TgChat {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  [k: string]: unknown;
}

export interface TgMessage {
  message_id: number;
  date?: number;
  edit_date?: number;
  business_connection_id?: string;
  from?: TgUser;
  chat?: TgChat;
  text?: string;
  caption?: string;
  photo?: unknown[];
  voice?: unknown;
  video?: unknown;
  video_note?: unknown;
  audio?: unknown;
  document?: unknown;
  animation?: unknown;
  sticker?: unknown;
  sender_business_bot?: TgUser;
  [k: string]: unknown;
}

export interface BusinessBotRights {
  can_reply?: boolean;
  can_read_messages?: boolean;
  can_delete_sent_messages?: boolean;
  can_delete_all_messages?: boolean;
  [k: string]: unknown;
}

export interface BusinessConnection {
  id: string;
  user?: TgUser;
  user_chat_id?: number;
  date?: number;
  rights?: BusinessBotRights;
  can_reply?: boolean; // deprecated since Bot API 9.0
  is_enabled?: boolean;
  [k: string]: unknown;
}

export interface BusinessMessagesDeleted {
  business_connection_id: string;
  chat: TgChat;
  message_ids: number[];
  [k: string]: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  business_connection?: BusinessConnection;
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  deleted_business_messages?: BusinessMessagesDeleted;
  [k: string]: unknown;
}

/** Update-type keys we care about, in priority order. */
export const UPDATE_TYPES = [
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'message',
  'edited_message',
] as const;

export type UpdateType = (typeof UPDATE_TYPES)[number];

/** Returns the first recognised update-type key present on the update. */
export function detectUpdateType(u: TgUpdate): UpdateType | 'unknown' {
  for (const t of UPDATE_TYPES) {
    if (u[t] !== undefined) return t;
  }
  return 'unknown';
}

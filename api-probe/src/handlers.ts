import { colors as c } from './logger.js';
import type {
  BusinessConnection,
  BusinessMessagesDeleted,
  TgMessage,
  TgUpdate,
} from './types.js';

/**
 * Per-type "analysis" printed after the raw dump. This is where the probe
 * highlights the research-critical fields (and the ones that are ABSENT).
 */

function h(title: string): void {
  console.log(`${c.bold}${c.cyan}   ↳ ${title}${c.reset}`);
}
function kv(key: string, val: unknown): void {
  console.log(`     ${c.dim}${key}:${c.reset} ${format(val)}`);
}
function flag(present: boolean, key: string, note = ''): void {
  const mark = present ? `${c.green}present${c.reset}` : `${c.red}ABSENT${c.reset}`;
  console.log(`     ${c.dim}${key}:${c.reset} ${mark}${note ? ` ${c.gray}(${note})${c.reset}` : ''}`);
}
function format(val: unknown): string {
  if (val === undefined) return `${c.red}undefined${c.reset}`;
  if (val === null) return `${c.gray}null${c.reset}`;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function mediaKind(m: TgMessage): string {
  if (m.photo) return 'photo';
  if (m.voice) return 'voice';
  if (m.video) return 'video';
  if (m.video_note) return 'video_note';
  if (m.audio) return 'audio';
  if (m.document) return 'document';
  if (m.animation) return 'animation';
  if (m.sticker) return 'sticker';
  if (m.text !== undefined) return 'text';
  return 'other';
}

function analyzeMessage(label: string, m: TgMessage): void {
  h(label);
  kv('business_connection_id', m.business_connection_id);
  kv('message_id', m.message_id);
  kv('from', m.from ? `${m.from.id} @${m.from.username ?? '-'}` : undefined);
  kv('chat', m.chat ? `${m.chat.id} (${m.chat.type ?? '?'})` : undefined);
  kv('kind', mediaKind(m));
  kv('date', m.date);
  kv('edit_date', m.edit_date);
  if (m.text !== undefined) kv('text', JSON.stringify(m.text));
  if (m.caption !== undefined) kv('caption', JSON.stringify(m.caption));
  if (m.sender_business_bot) kv('sender_business_bot', m.sender_business_bot.id);
}

function analyzeConnection(bc: BusinessConnection): void {
  h('BusinessConnection');
  kv('id', bc.id);
  kv('user', bc.user ? `${bc.user.id} @${bc.user.username ?? '-'}` : undefined);
  kv('user_chat_id', bc.user_chat_id);
  kv('date', bc.date);
  kv('is_enabled', bc.is_enabled);
  kv('rights', bc.rights ?? bc.can_reply /* pre-9.0 fallback */);
}

function analyzeDeleted(d: BusinessMessagesDeleted): void {
  h('BusinessMessagesDeleted  — the research-critical payload');
  kv('business_connection_id', d.business_connection_id);
  kv('chat', d.chat ? `${d.chat.id} (${d.chat.type ?? '?'})` : undefined);
  kv('message_ids', d.message_ids);
  kv('count', Array.isArray(d.message_ids) ? d.message_ids.length : 0);
  console.log(`     ${c.gray}— checking for fields the product would need —${c.reset}`);
  flag('text' in d || 'messages' in d, 'deleted content', 'expected ABSENT per docs');
  flag('from' in d || 'deleted_by' in d || 'initiator' in d, 'initiator / who deleted', 'expected ABSENT per docs');
  flag('date' in d || 'delete_date' in d, 'deletion timestamp', 'expected ABSENT per docs');
}

/** Dispatch analysis based on which update field is present. */
export function analyze(update: TgUpdate): void {
  if (update.business_connection) return analyzeConnection(update.business_connection);
  if (update.business_message) return analyzeMessage('business_message (Message)', update.business_message);
  if (update.edited_business_message)
    return analyzeMessage('edited_business_message (Message)', update.edited_business_message);
  if (update.deleted_business_messages) return analyzeDeleted(update.deleted_business_messages);
  if (update.message) return analyzeMessage('message (Message)', update.message);
  if (update.edited_message) return analyzeMessage('edited_message (Message)', update.edited_message);
  console.log(`     ${c.gray}(no specialised analyzer for this update type)${c.reset}`);
}

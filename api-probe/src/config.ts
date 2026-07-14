import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`\n[config] Missing required env var: ${name}`);
    console.error('[config] Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

const publicUrl = required('PUBLIC_URL').replace(/\/+$/, '');

export const config = {
  botToken: required('BOT_TOKEN'),
  webhookSecret: required('WEBHOOK_SECRET'),
  publicUrl,
  port: Number(optional('PORT', '3000')),
  apiRoot: optional('TELEGRAM_API_ROOT', 'https://api.telegram.org').replace(/\/+$/, ''),
  /** Path we serve the webhook on. */
  webhookPath: '/webhook',
} as const;

/** Full public webhook URL registered with Telegram. */
export const webhookUrl = `${config.publicUrl}${config.webhookPath}`;

/** Base URL for Bot API calls, token embedded. */
export const apiBase = `${config.apiRoot}/bot${config.botToken}`;

/** The four business updates are NOT delivered by default — must be requested explicitly. */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;

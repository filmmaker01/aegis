/**
 * Registers the Telegram webhook for the planner.
 *
 * WHY THIS EXISTS: the bot previously ran as a Business bot, and its webhook was
 * registered with `allowed_updates` = the four business_* types (+ callback_query).
 * `message` was NOT in that list, so with the old registration the planner receives
 * NO commands at all — /start never arrives and the bot looks dead. Re-registering
 * with the list below is a REQUIRED cutover step, not an optional one.
 *
 * Deliberately a manual script, not something the server does on boot: setWebhook
 * is rate-limited and re-registering on every deploy is a known way to get 429s.
 *
 *   bun run --cwd backend set-webhook -- --url https://<host>/telegram/webhook
 *   bun run --cwd backend set-webhook -- --url https://<host>/telegram/webhook --drop-pending
 *   bun run --cwd backend set-webhook -- --info      # read-only: show current state
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment
 * (backend/.env is loaded automatically). Never prints either of them.
 */

import 'dotenv/config'

/**
 * The planner needs exactly these two:
 *   message        — /start, /new, /tasks, /today, /settings, /cancel, and the
 *                    free text typed for a task title or a custom date.
 *   callback_query — every inline button.
 * The business_* types are deliberately absent: the archive that consumed them is
 * gone, and leaving them subscribed only burns update_ids on traffic we ignore.
 */
const ALLOWED_UPDATES = ['message', 'callback_query']

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set (backend/.env or the environment).')
  process.exit(1)
}

const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res.json()
}

/** Masks the host so a webhook URL never lands in a log or a screenshot verbatim. */
const maskUrl = (url) => (url ? String(url).replace(/\/\/[^/]+/, '//<host>') : '(none)')

async function showInfo(label) {
  const info = await api('getWebhookInfo')
  const r = info.result ?? {}
  console.log(`\n${label}`)
  console.log('  url                  =', maskUrl(r.url))
  console.log('  pending_update_count =', r.pending_update_count ?? 0)
  console.log('  allowed_updates      =', JSON.stringify(r.allowed_updates ?? '(default)'))
  console.log('  last_error_message   =', r.last_error_message ?? '(none)')
  return r
}

if (has('--info')) {
  const me = await api('getMe')
  console.log('bot username =', me.result?.username ?? '(unknown)')
  const r = await showInfo('current webhook:')
  const allowed = r.allowed_updates ?? []
  if (allowed.length > 0 && !allowed.includes('message')) {
    console.error('\n  ⚠️  `message` is NOT allowed — the planner cannot receive ANY command.')
    console.error('      Fix: bun run --cwd backend set-webhook -- --url https://<host>/telegram/webhook')
  }
  process.exit(0)
}

const url = valueOf('--url') ?? process.env.TELEGRAM_WEBHOOK_URL
if (!url) {
  console.error('Missing --url (or TELEGRAM_WEBHOOK_URL). Example:')
  console.error('  bun run --cwd backend set-webhook -- --url https://<host>/telegram/webhook')
  process.exit(1)
}
if (!url.startsWith('https://')) {
  console.error('Telegram requires an https webhook URL.')
  process.exit(1)
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET
if (!secret) {
  console.error('TELEGRAM_WEBHOOK_SECRET is not set. The webhook route rejects every request without it.')
  process.exit(1)
}

await showInfo('before:')

const result = await api('setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ALLOWED_UPDATES,
  // The queue may still hold business_* updates aimed at the retired archive.
  // Changing allowed_updates does not discard updates created before this call.
  drop_pending_updates: has('--drop-pending'),
})

if (!result.ok) {
  console.error('\nsetWebhook FAILED:', result.description)
  process.exit(1)
}
console.log('\nsetWebhook ok. drop_pending_updates =', has('--drop-pending'))

await showInfo('after:')

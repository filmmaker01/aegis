// Live webhook watcher for the Business API experiments.
// Polls logs/ for NEW per-update JSON files and, for each, prints:
//   - event type
//   - full (flattened) field list
//   - fields seen for the FIRST time for that type this session
//   - rights actually granted (for business_connection)
//   - a short "limitations" note
// The first business_message is also appended (ANONYMIZED) to
//   docs/telegram-live-payloads.md
//
// Usage:  node scripts/live-watch.mjs [seconds]   (default 240)

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(__dirname, '..', 'logs')
const DOCS = join(__dirname, '..', '..', 'docs', 'telegram-live-payloads.md')

const runSeconds = Number(process.argv[2] ?? 240)
const seen = new Set(readdirSync(LOG_DIR).filter((f) => f.endsWith('.json')))
const firstSeenByType = new Map() // type -> Set(fieldPath)
let savedBusinessMessage = false

// ---- anonymization ----
const MASK_TEXT_KEYS = new Set(['text', 'caption'])
const DROP_ID_KEYS = new Set(['id', 'user_id', 'user_chat_id', 'sender_chat_id', 'chat_instance'])
const NAME_KEYS = new Set(['first_name', 'last_name', 'username', 'phone_number', 'title', 'bio'])

function anonymize(value, keyName = '', parentKey = '') {
  if (Array.isArray(value)) return value.map((v) => anonymize(v, keyName, parentKey))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = anonymize(v, k, keyName)
    return out
  }
  // scalars
  if (keyName === 'message_id' || keyName === 'update_id' || keyName === 'message_ids') return value
  if (keyName === 'business_connection_id' && typeof value === 'string')
    return `${value.slice(0, 4)}…<len:${value.length}>`
  if (NAME_KEYS.has(keyName)) return `<${keyName}>`
  if (MASK_TEXT_KEYS.has(keyName) && typeof value === 'string') return `<${keyName}:${value.length} chars>`
  // ids that identify people/chats (but keep media file ids)
  if (DROP_ID_KEYS.has(keyName) && (parentKey === 'user' || parentKey === 'chat' || parentKey === 'from' || parentKey === 'sender_business_bot' || parentKey === '' )) {
    return typeof value === 'number' ? `<${parentKey || 'obj'}.${keyName}>` : value
  }
  return value
}

function flatten(o, p = '', acc = []) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o)) {
      const key = p ? `${p}.${k}` : k
      const v = o[k]
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        acc.push(`${key} (object)`)
        flatten(v, key, acc)
      } else if (Array.isArray(v)) {
        acc.push(`${key} (array[${v.length}])`)
        if (v[0] && typeof v[0] === 'object') flatten(v[0], `${key}[0]`, acc)
      } else {
        acc.push(key)
      }
    }
  }
  return acc
}

function typeOf(update) {
  for (const t of [
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
    'message',
    'edited_message',
  ]) if (update[t] !== undefined) return t
  return 'unknown'
}

function mediaKind(m) {
  for (const k of ['photo', 'voice', 'video', 'video_note', 'audio', 'document', 'animation', 'sticker'])
    if (m?.[k]) return k
  if (m?.text !== undefined) return 'text'
  return 'other'
}

function limitations(type, update) {
  const notes = []
  if (type === 'business_connection') {
    const bc = update.business_connection
    const rk = Object.keys(bc.rights ?? {})
    if (rk.length === 0) notes.push('rights = {} → NO rights granted (no reply/read/delete/manage)')
    if (bc.can_reply === false) notes.push('can_reply=false → cannot send/edit in chats')
    if (bc.is_enabled === false) notes.push('is_enabled=false → connection disabled')
  }
  if (type === 'deleted_business_messages') {
    const d = update.deleted_business_messages
    notes.push('carries ONLY: ' + Object.keys(d).join(', '))
    if (!('text' in d)) notes.push('no deleted content')
    if (!('from' in d) && !('initiator' in d)) notes.push('no initiator (cannot tell who deleted)')
    if (!('date' in d)) notes.push('no deletion timestamp')
  }
  if (type === 'business_message' || type === 'edited_business_message') {
    const m = update[type]
    notes.push('kind=' + mediaKind(m))
    if (m.edit_date) notes.push('edit_date present')
    if (m.sender_business_bot) notes.push('sender_business_bot present (outgoing)')
  }
  return notes
}

function analyze(file) {
  const rec = JSON.parse(readFileSync(join(LOG_DIR, file), 'utf8'))
  const update = rec.update
  const type = typeOf(update)
  const payload = update[type] ?? update
  const paths = flatten(payload)

  if (!firstSeenByType.has(type)) firstSeenByType.set(type, new Set())
  const known = firstSeenByType.get(type)
  const firstSeen = paths.filter((p) => !known.has(p))
  paths.forEach((p) => known.add(p))

  const bar = '━'.repeat(70)
  console.log(`\n${bar}`)
  console.log(`▶ ${type}   update_id=${update.update_id}   @ ${rec.received_at}`)
  console.log(bar)
  console.log('• fields:')
  console.log('   ' + paths.join('\n   '))
  console.log('• first-seen fields for this type:', firstSeen.length ? firstSeen.join(', ') : '(none new)')
  if (type === 'business_connection') {
    console.log('• rights granted:', JSON.stringify(update.business_connection.rights ?? {}))
  }
  console.log('• limitations:', limitations(type, update).map((n) => '\n   - ' + n).join(''))
  console.log('• ANONYMIZED payload:')
  console.log(JSON.stringify(anonymize(payload), null, 2))

  if (type === 'business_message' && !savedBusinessMessage) {
    saveToDocs(type, anonymize(payload), paths)
    savedBusinessMessage = true
    console.log(`\n  ↳ anonymized business_message saved to docs/telegram-live-payloads.md`)
  }
}

function saveToDocs(type, anonPayload, paths) {
  if (!existsSync(dirname(DOCS))) mkdirSync(dirname(DOCS), { recursive: true })
  const header = existsSync(DOCS)
    ? ''
    : `# Telegram Business API — live payloads (anonymized)\n\nReal payloads captured by api-probe. Personal identifiers (ids, names, usernames, message text) are masked; structure and field presence are preserved.\n`
  const block =
    `\n## ${type} (first capture)\n\n` +
    `Field list:\n\n\`\`\`\n${paths.join('\n')}\n\`\`\`\n\n` +
    `Anonymized payload:\n\n\`\`\`json\n${JSON.stringify(anonPayload, null, 2)}\n\`\`\`\n`
  appendFileSync(DOCS, header + block, 'utf8')
}

console.log(`[live-watch] watching logs/ for ${runSeconds}s … (${seen.size} existing files ignored)`)
const started = Date.now()
const timer = setInterval(() => {
  const files = readdirSync(LOG_DIR).filter((f) => f.endsWith('.json'))
  for (const f of files.sort()) {
    if (!seen.has(f)) {
      seen.add(f)
      try {
        analyze(f)
      } catch (e) {
        console.log('  ! failed to analyze', f, String(e))
      }
    }
  }
  if (Date.now() - started > runSeconds * 1000) {
    clearInterval(timer)
    console.log(`\n[live-watch] done (${runSeconds}s elapsed).`)
    process.exit(0)
  }
}, 2000)

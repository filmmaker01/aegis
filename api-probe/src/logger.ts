import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TgUpdate } from './types.js';
import { detectUpdateType } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');
const NDJSON_PATH = join(LOG_DIR, 'all-updates.ndjson');

mkdirSync(LOG_DIR, { recursive: true });

// --- tiny ANSI colour helpers (no dependency) ---
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const TYPE_COLOR: Record<string, string> = {
  business_connection: c.magenta,
  business_message: c.green,
  edited_business_message: c.yellow,
  deleted_business_messages: c.red,
  message: c.blue,
  edited_message: c.cyan,
  unknown: c.gray,
};

function ts(): string {
  return new Date().toISOString();
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Persist the raw update two ways:
 *  1. one pretty JSON file per update (easy to inspect a single payload)
 *  2. append to a single NDJSON stream (easy to diff / grep the whole session)
 */
export function persistRaw(update: TgUpdate): string {
  const type = detectUpdateType(update);
  const stamp = ts().replace(/[:.]/g, '-');
  const file = join(LOG_DIR, `${stamp}__${safeName(type)}__u${update.update_id}.json`);

  const record = { received_at: ts(), type, update };
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  appendFileSync(NDJSON_PATH, JSON.stringify(record) + '\n', 'utf8');
  return file;
}

/** Pretty, colourised console dump of the whole update. */
export function printUpdate(update: TgUpdate, savedFile: string): void {
  const type = detectUpdateType(update);
  const color = TYPE_COLOR[type] ?? c.gray;
  const line = '─'.repeat(72);

  console.log(`\n${color}${line}${c.reset}`);
  console.log(
    `${color}${c.bold}▶ ${type}${c.reset}  ${c.dim}update_id=${update.update_id}  @ ${ts()}${c.reset}`,
  );
  console.log(`${c.gray}saved: ${savedFile}${c.reset}`);
  console.log(`${color}${line}${c.reset}`);
  console.log(inspect(update, { depth: null, colors: true, compact: false }));
}

export const colors = c;

export function info(msg: string): void {
  console.log(`${c.cyan}[probe]${c.reset} ${msg}`);
}
export function warn(msg: string): void {
  console.log(`${c.yellow}[probe]${c.reset} ${msg}`);
}
export function error(msg: string): void {
  console.log(`${c.red}[probe]${c.reset} ${msg}`);
}

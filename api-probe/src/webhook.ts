import type { Request, Response } from 'express';
import { config } from './config.js';
import { persistRaw, printUpdate, warn } from './logger.js';
import { analyze } from './handlers.js';
import type { TgUpdate } from './types.js';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Webhook endpoint.
 * 1. Verify the secret token header (reject anything that isn't from our setWebhook).
 * 2. Persist the raw update.
 * 3. Pretty-print + analyze.
 * 4. Always ack 200 fast (Telegram retries on non-2xx).
 */
export function handleWebhook(req: Request, res: Response): void {
  const got = req.get(SECRET_HEADER);
  if (got !== config.webhookSecret) {
    warn(`Rejected webhook: bad or missing ${SECRET_HEADER} (got: ${got ?? 'none'})`);
    res.status(401).send('unauthorized');
    return;
  }

  const update = req.body as TgUpdate;
  if (!update || typeof update.update_id !== 'number') {
    warn('Rejected webhook: body is not a Telegram Update');
    res.status(400).send('bad request');
    return;
  }

  // Ack immediately, then log (logging is sync+cheap here, but ack first is the right habit).
  res.status(200).send('ok');

  try {
    const savedFile = persistRaw(update);
    printUpdate(update, savedFile);
    analyze(update);
  } catch (err) {
    warn(`Failed to log update ${update.update_id}: ${(err as Error).message}`);
  }
}

import { config, webhookUrl, ALLOWED_UPDATES } from '../src/config.js';
import { callApi } from './api.js';

/**
 * Registers the webhook with Telegram.
 *  - url: our public tunnel URL + /webhook
 *  - secret_token: verified on every incoming request
 *  - allowed_updates: MUST include the four business_* types (off by default)
 *  - drop_pending_updates: start clean for each experiment run
 */
async function main() {
  console.log(`Setting webhook -> ${webhookUrl}`);
  console.log(`allowed_updates: ${ALLOWED_UPDATES.join(', ')}`);

  const ok = await callApi<boolean>('setWebhook', {
    url: webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: true,
    max_connections: 10,
  });
  console.log(`setWebhook result: ${ok}`);

  const infoResult = await callApi<Record<string, unknown>>('getWebhookInfo');
  console.log('\ngetWebhookInfo:');
  console.log(JSON.stringify(infoResult, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

import { callApi } from './api.js';

/** Removes the webhook (use when switching back to getUpdates, or cleaning up). */
async function main() {
  const ok = await callApi<boolean>('deleteWebhook', { drop_pending_updates: false });
  console.log(`deleteWebhook result: ${ok}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

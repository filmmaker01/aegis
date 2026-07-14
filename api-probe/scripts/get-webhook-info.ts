import { callApi } from './api.js';

/** Shows current webhook status: URL, pending count, last error, allowed_updates. */
async function main() {
  const info = await callApi<Record<string, unknown>>('getWebhookInfo');
  console.log(JSON.stringify(info, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

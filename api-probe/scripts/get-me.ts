import { callApi } from './api.js';

/**
 * Sanity check the token and, importantly, whether Business Mode is on.
 * A business-capable bot reports `can_connect_to_business: true` in getMe.
 */
async function main() {
  const me = await callApi<Record<string, unknown>>('getMe');
  console.log(JSON.stringify(me, null, 2));
  if (me['can_connect_to_business'] !== true) {
    console.log(
      '\n[!] can_connect_to_business is not true — enable "Business Mode" for this bot in @BotFather (Bot Settings -> Business Mode).',
    );
  } else {
    console.log('\n[ok] Business Mode is enabled — the bot can be connected to a business account.');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

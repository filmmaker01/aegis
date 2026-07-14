import express from 'express';
import { config, webhookUrl } from './config.js';
import { handleWebhook } from './webhook.js';
import { info, colors as c } from './logger.js';

const app = express();

// Raw-safe JSON parsing; Telegram sends application/json.
app.use(express.json({ limit: '5mb' }));

// Health check for the tunnel / quick manual test.
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'telegram-business-api-probe', webhookPath: config.webhookPath });
});

app.post(config.webhookPath, handleWebhook);

app.listen(config.port, () => {
  console.log(`\n${c.bold}${c.green}Telegram Business API Probe${c.reset}`);
  info(`Listening on http://localhost:${config.port}`);
  info(`Webhook path: ${config.webhookPath}`);
  info(`Public webhook URL (register this): ${c.bold}${webhookUrl}${c.reset}`);
  info(`Next: run "npm run set-webhook" once your tunnel points at PORT ${config.port}.`);
  console.log(`${c.dim}Waiting for updates… raw payloads are saved to ./logs/${c.reset}\n`);
});

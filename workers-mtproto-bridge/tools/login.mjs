import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = Number.parseInt(process.env.TG_USER_API_ID || '', 10);
const apiHash = String(process.env.TG_USER_API_HASH || '').trim();
const existingSession = String(process.env.TG_MT_STRING_SESSION || '').trim();

if (!Number.isFinite(apiId) || !apiHash) {
  console.error('TG_USER_API_ID and TG_USER_API_HASH are required.');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const client = new TelegramClient(new StringSession(existingSession), apiId, apiHash, {
  connectionRetries: 5
});

await client.start({
  phoneNumber: async () => rl.question('Telegram phone number: '),
  password: async () => rl.question('Telegram 2FA password (leave blank if none): '),
  phoneCode: async () => rl.question('Telegram login code: '),
  onError: (error) => console.error(error)
});

console.log('\nTG_MT_STRING_SESSION=' + client.session.save());
await client.disconnect();
rl.close();

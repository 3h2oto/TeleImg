import { TelegramClient } from 'telegram';
import input from 'input';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = Number.parseInt(process.env.TG_USER_API_ID || '', 10);
const apiHash = String(process.env.TG_USER_API_HASH || '').trim();
const existingSession = String(process.env.TG_USER_SESSION || '').trim();

if (!Number.isFinite(apiId) || !apiHash) {
  console.error('TG_USER_API_ID and TG_USER_API_HASH are required.');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(existingSession), apiId, apiHash, {
  connectionRetries: 5,
  useWSS: false
});

await client.start({
  phoneNumber: async () => input.text('Telegram phone number: '),
  password: async () => input.password('Telegram 2FA password (leave blank if none): '),
  phoneCode: async () => input.text('Telegram login code: '),
  onError: (error) => console.error(error)
});

console.log('\nTG_USER_SESSION=' + client.session.save());
await client.disconnect();

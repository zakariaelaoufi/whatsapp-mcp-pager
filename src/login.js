import qrcode from 'qrcode-terminal';
import wwebjs from 'whatsapp-web.js';
import { AUTH_DATA_PATH, config, validateConfig } from './config.js';

const { Client, LocalAuth } = wwebjs;

validateConfig({ requireOpenAI: false });

console.error('🔄 Initializing WhatsApp Web client for QR pairing...');
console.error(`📁 Auth session directory: ${AUTH_DATA_PATH}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.error('\n📱 Scan this QR code in WhatsApp (Linked Devices -> Link a Device):\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.error('🔐 WhatsApp authenticated! Saving session...');
});

client.on('auth_failure', (msg) => {
  console.error('❌ WhatsApp authentication failed:', msg);
  process.exit(1);
});

client.on('ready', async () => {
  console.error('✅ WhatsApp client is ready!');
  const targetId = process.env.MY_WHATSAPP_ID || config.myWhatsappId;

  try {
    await client.sendMessage(targetId, '✅ Coding Agent Pager linked and ready!');
    console.error(`📨 Sent confirmation message to ${targetId}`);
  } catch (err) {
    console.error(`⚠️ Connected, but could not send test message to ${targetId}:`, err.message);
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
  await client.destroy();
  console.error('👋 Session saved to .wwebjs_auth/ and client closed cleanly.');
  process.exit(0);
});

client.initialize().catch((err) => {
  console.error('❌ Failed to initialize WhatsApp client:', err);
  process.exit(1);
});


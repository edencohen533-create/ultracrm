/* eslint-disable @typescript-eslint/no-require-imports */
// Run every QA command with explicit local-only configuration, overriding .env files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.qa-local');
fs.mkdirSync(dir, { recursive: true });
const keyFile = path.join(dir, 'keys.json');
if (!fs.existsSync(keyFile)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, JSON.stringify({ privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') }), { mode: 0o600 });
}
const keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const env = { ...process.env,
  DATABASE_URL: 'postgresql://qa:local-qa-only@127.0.0.1:55439/dialer_qa?schema=dialer',
  DATABASE_URL_UNPOOLED: 'postgresql://qa:local-qa-only@127.0.0.1:55439/dialer_qa?schema=dialer',
  JWT_SECRET: 'local-qa-only-session-secret-20260924-unsafe-outside-tests',
  CRON_SECRET: 'local-qa-only-cron-secret', TELEPHONY_PROVIDER: 'mock',
  TELNYX_API_KEY: '', TELNYX_CALL_CONTROL_APP_ID: '', TELNYX_CREDENTIAL_CONNECTION_ID: '',
  TELNYX_PUBLIC_KEY: keys.publicKey,
  QA_BASE: 'http://127.0.0.1:3107', NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3107',
  QA_IDS: path.join(dir, 'ids.json'), QA_KEYS: keyFile, QA_SHOTS: process.env.QA_SHOTS ?? path.join(dir, 'shots'),
  TZ: 'Asia/Jerusalem', QA_LOCAL: '1',
};
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/qa-local.cjs <command> [args]');
const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

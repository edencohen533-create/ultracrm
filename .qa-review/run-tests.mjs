// Deliberately local-only: never falls back to a .env database or real provider.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const local='postgresql://qa:review-local-only@127.0.0.1:55449/ultracrm_review';
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','.qa-review/vitest.config.mts'],{cwd,stdio:'inherit',env:{...process.env,DATABASE_URL:local,DATABASE_URL_UNPOOLED:local,DB_RLS:'on',TELEPHONY_PROVIDER:'mock',NUMBER_PROVIDER:'mock',JWT_SECRET:'review-only-secret-at-least-32-characters-long',ENCRYPTION_KEY:'1'.repeat(64)}});
if(result.error)throw result.error;
process.exit(result.status??1);

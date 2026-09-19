// 种子超级管理员脚本
// 用法:
//   node scripts/seed-admin.mjs --username admin --password <你的密码> [--remote]
// 或通过环境变量:SEED_USERNAME / SEED_PASSWORD
// 说明:密码在此用与 src/lib/auth.ts 完全一致的 PBKDF2-SHA256(100000 次)算法哈希后写入 D1,
//       数据库只存 salt + hash,不存明文。--remote 写入线上 D1,默认写入本地 D1。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const wranglerJs = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const username = arg('username') || process.env.SEED_USERNAME;
const password = arg('password') || process.env.SEED_PASSWORD;
const remote = process.argv.includes('--remote');

if (!username || !password) {
  console.error('缺少参数。用法: node scripts/seed-admin.mjs --username <名> --password <密码> [--remote]');
  process.exit(1);
}
if (password.length < 6) {
  console.error('密码至少 6 位。');
  process.exit(1);
}

// ---- 与 src/lib/auth.ts 保持一致的哈希实现 ----
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const enc = new TextEncoder();

function generateSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}
async function hashPassword(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(saltHex), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

const id = crypto.randomUUID();
const salt = generateSalt();
const passwordHash = await hashPassword(password, salt);
const createdAt = Math.floor(Date.now() / 1000);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql =
  `INSERT INTO users (id, org_id, username, password_hash, salt, role, created_at) ` +
  `VALUES (${q(id)}, NULL, ${q(username)}, ${q(passwordHash)}, ${q(salt)}, 'superadmin', ${createdAt});`;

console.log(`正在${remote ? '线上' : '本地'} D1 创建超级管理员: ${username}`);
const res = spawnSync(
  process.execPath,
  [
    wranglerJs,
    'd1',
    'execute',
    'medie-manage-db',
    remote ? '--remote' : '--local',
    '--command',
    sql,
  ],
  { cwd: root, stdio: 'inherit' },
);

if (res.status !== 0) {
  console.error('写入失败,请确认已运行数据库迁移(npm run db:migrate:local / :remote)。');
  process.exit(res.status ?? 1);
}
console.log('超级管理员创建完成。');

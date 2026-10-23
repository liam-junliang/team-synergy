import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function run(databaseUrl) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'db:plan-tenants'], {
    env: { ...process.env, TSP_DATABASE_URL: databaseUrl, NODE_USE_ENV_PROXY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = ''; let err = '';
  child.stdout.on('data', data => { out += data; });
  child.stderr.on('data', data => { err += data; });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  return { code, out, err };
}

test('tenant planning requires an explicit local database URL', async () => {
  const result = await run('  ');
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.out), { ok: false, error: { code: 'database_url_required', message: '必须显式设置服务器本机 TSP_DATABASE_URL' } });
});

test('tenant planning redacts malformed URLs and unreachable credential-bearing connections', async () => {
  for (const databaseUrl of ['postgres://fixture-user:fixture-private-password@[invalid/no_database', 'postgres://fixture-user:fixture-private-password@127.0.0.1:1/no_database']) {
    const result = await run(databaseUrl);
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.out), { ok: false, error: { code: 'tenant_inventory_failed', message: '只读客户映射盘点失败，请检查数据库权限、迁移版本或查询时限' } });
    assert.doesNotMatch(result.out + result.err, /fixture-user|fixture-private-password|no_database/);
    assert.equal(result.err, '');
  }
});

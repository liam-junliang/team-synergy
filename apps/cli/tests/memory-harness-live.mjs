// Explicit opt-in real hosts. All accounts, host homes, SQLite and HTTP are
// isolated fixtures; only the requested loopback Flash provider is real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { harnessFixture } from './memory-harness-fixture.mjs';

const model = 'officeace/deepseek-v4.1-flash', baseURL = 'http://127.0.0.1:3425/v1';
const requested = process.env.TSP_LIVE_HARNESS;
const inputs = ['Isolated native transport check one. Reply OK without tools.', 'Isolated native transport check two. Reply OK without tools.'];
function isolated(f) {
  const env = { ...f.env, HOME: f.home, USERPROFILE: f.home, APPDATA: f.home, LOCALAPPDATA: f.home,
    XDG_CONFIG_HOME: path.join(f.home, 'config'), XDG_CACHE_HOME: path.join(f.home, 'cache'),
    XDG_DATA_HOME: path.join(f.home, 'data'), XDG_STATE_HOME: path.join(f.home, 'state'),
    CODEX_HOME: f.home, DSH_HOME: f.home, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '',
    DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', DEEPSEEK_API_KEY: 'local-test', DSH_PRIMARY_RUNTIME: '',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_CONFIG_CONTENT: '',
    OPENCODE_TEST_HOME: f.home, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'isolated-probe-only' };
  for (const folder of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) mkdirSync(folder, { recursive: true });
  return env;
}
async function runHost(f, runtime, args, env) {
  const child = spawn(runtime, args, { cwd: f.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.setEncoding('utf8').on('data', chunk => output += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => errors += chunk);
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const [code] = await once(child, 'close');
    // Logs contain only this fixture's synthetic input and may aid local diagnosis.
    if (process.env.TSP_HARNESS_LOG) writeFileSync(process.env.TSP_HARNESS_LOG, output + '\n' + errors);
    assert.equal(code, 0, 'native host failed; inspect the isolated log');
    return output;
  } finally { clearTimeout(timer); }
}
async function collected(f, count) {
  const until = Date.now() + 15000;
  while (f.posts.length < count && Date.now() < until) await delay(100);
  if (f.posts.length !== count && f.installationFile && process.env.TSP_HARNESS_LOG) {
    const registration = JSON.parse(readFileSync(f.installationFile, 'utf8'));
    try { appendFileSync(process.env.TSP_HARNESS_LOG, '\nCAPTURE AUDIT\n' + readFileSync(registration.auditFile, 'utf8')); }
    catch { appendFileSync(process.env.TSP_HARNESS_LOG, '\nNO CAPTURE AUDIT\n'); }
    for (const file of readdirSync(path.join(f.home, 'sessions'), { recursive: true }).filter(file => String(file).endsWith('.jsonl'))) {
      for (const line of readFileSync(path.join(f.home, 'sessions', file), 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.type === 'session_meta' || row.type === 'turn_context' || row.type === 'event_msg')
          appendFileSync(process.env.TSP_HARNESS_LOG, '\nNATIVE FIXTURE ' + line);
      }
    }
  }
  assert.equal(f.posts.length, count, 'installed native plugin must enqueue and asynchronously deliver');
}
function report(harness, installed, f, extra = {}) {
  assert.deepEqual(f.posts.map(row => row.sourceText).sort(), [...inputs].sort());
  assert.equal(new Set(f.posts.map(row => row.sessionId)).size, 2);
  const result = { harness, version: installed.hostVersion, model, newNativeSessions: 2,
    capturedInputs: f.posts.length, uniqueEvents: new Set(f.posts.map(row => row.eventId)).size,
    backend: 'isolated authenticated HTTP fixture; no business database', installation: 'persistent host config, dynamic sessions', ...extra };
  console.log(JSON.stringify(result));
  if (process.env.TSP_HARNESS_REPORT) appendFileSync(process.env.TSP_HARNESS_REPORT, JSON.stringify(result) + '\n');
}

test('installed Codex hooks collect two automatically created sessions', { skip: requested !== 'codex', timeout: 220000 }, async t => {
  const f = await harnessFixture(t), runtime = process.env.TSP_CODEX_RUNTIME; assert.ok(path.isAbsolute(runtime ?? ''));
  writeFileSync(path.join(f.home, 'config.toml'), `model=${JSON.stringify(model)}\nmodel_provider="magpie"\nmodel_reasoning_effort="low"\n[model_providers.magpie]\nname="Local Magpie"\nbase_url=${JSON.stringify(baseURL)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\nhooks=true\n`);
  const installed = await f.install('codex', { '--runtime': runtime }); assert.equal(installed.code, 0, installed.error);
  f.installationFile = installed.value.data.installationFile;
  const env = isolated(f);
  for (let i = 0; i < inputs.length; i++) {
    await runHost(f, runtime, ['--dangerously-bypass-hook-trust', '-a', 'on-request', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', f.cwd, '--json', inputs[i]], env);
    await collected(f, i + 1);
  }
  const diagnosis = await f.run(['doctor', '--harness', 'codex']);
  assert.equal(diagnosis.value.data.status, 'local_capture_observed');
  report('codex', installed.value.data, f, { trust: 'temporary sole-owned hooks, official one-shot hook trust bypass only', desktopTrust: 'requires user review in /hooks' });
});

test('installed DSH home patch collects two normal headless sessions', { skip: requested !== 'dsh', timeout: 220000 }, async t => {
  const f = await harnessFixture(t), runtime = process.env.TSP_DSH_RUNTIME; assert.ok(path.isAbsolute(runtime ?? ''));
  const excluded = ['llm-pi-ai', 'llm-deepseek-account', 'agent-instructions', 'remote-access', 'session-title-llm',
    'tool-plugin-manager', 'tool-working-directory', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill',
    'tool-workflow', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'tool-todo',
    'tool-goal', 'tool-web', 'web-deepseek-api', 'web-search-deepseek', 'web-fetch-http', 'session-telemetry-otel'];
  const patch = [...excluded.map(id => ({ id, disabled: true })),
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: f.cwd } },
    { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:3425', apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled',
      maxTokens: 256, models: [{ id: model, name: model, inputModalities: ['text'] }], retryPolicy: { mode: 'normal', maxRetries: 0 } } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
    { id: 'system-prompt', config: { personaPrefix: 'Reply OK without tools.', includeRuntimeContext: false, includeHarnessIdentity: false } }];
  writeFileSync(path.join(f.home, 'cordis.patch.yml'), JSON.stringify(patch));
  const installed = await f.install('dsh', { '--runtime': runtime }); assert.equal(installed.code, 0, installed.error);
  const env = isolated(f);
  for (let i = 0; i < inputs.length; i++) {
    await runHost(f, process.execPath, [runtime, '--profile', 'headless', '--json', inputs[i]], env);
    await collected(f, i + 1);
  }
  report('dsh', installed.value.data, f);
});

test('installed OpenCode config collects new sessions across a native server restart', { skip: requested !== 'opencode', timeout: 220000 }, async t => {
  const f = await harnessFixture(t), runtime = process.env.TSP_OPENCODE_RUNTIME; assert.ok(path.isAbsolute(runtime ?? ''));
  const env = isolated(f), hostHome = path.join(env.XDG_CONFIG_HOME, 'opencode'); mkdirSync(hostHome, { recursive: true });
  writeFileSync(path.join(hostHome, 'opencode.json'), JSON.stringify({ model: 'local/flash', small_model: 'local/flash', enabled_providers: ['local'],
    autoupdate: false, share: 'disabled', snapshot: false, lsp: false, formatter: false, permission: { '*': 'deny' },
    agent: { member: { mode: 'primary', prompt: 'Reply OK without tools.', temperature: 0, steps: 1 } },
    provider: { local: { npm: '@ai-sdk/openai-compatible', name: 'Local Magpie', options: { baseURL, apiKey: 'local-test', timeout: 60000 },
      models: { flash: { id: model, name: model, tool_call: true, limit: { context: 16384, output: 256 } } } } } }));
  const installed = await f.install('opencode', { '--runtime': runtime, '--host-home': hostHome }); assert.equal(installed.code, 0, installed.error);
  for (let i = 0; i < inputs.length; i++) {
    const proc = spawn(runtime, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: f.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(proc, 'close'); let output = '', errors = '';
    proc.stderr.setEncoding('utf8').on('data', chunk => errors += chunk);
    const address = new Promise((resolve, reject) => {
      proc.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(output); if (match) resolve(match[1]); });
      proc.once('close', () => reject(Error('native server exited'))); proc.once('error', reject);
    });
    const timer = setTimeout(() => proc.kill(), 90000);
    try {
      const base = await address;
      const request = async (method, route, body) => {
        const url = new URL(route, base); url.searchParams.set('directory', f.cwd);
        const response = await fetch(url, { method, headers: { authorization: 'Basic ' + Buffer.from('opencode:isolated-probe-only').toString('base64'), 'content-type': 'application/json' },
          signal: AbortSignal.timeout(75000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        assert.equal(response.status, 200); return response.json();
      };
      const session = await request('POST', '/session', { title: 'Isolated persistent capture check' });
      await request('POST', '/session/' + session.id + '/message', { agent: 'member', model: { providerID: 'local', modelID: 'flash' }, parts: [{ type: 'text', text: inputs[i] }] });
      await collected(f, i + 1);
    } finally {
      clearTimeout(timer); proc.kill(); await closed;
      if (process.env.TSP_HARNESS_LOG) writeFileSync(process.env.TSP_HARNESS_LOG, output + '\n' + errors);
    }
  }
  report('opencode', installed.value.data, f, { nativeServerRestarted: true });
});

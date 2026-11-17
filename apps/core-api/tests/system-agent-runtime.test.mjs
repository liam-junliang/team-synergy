import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import {
  createSystemAgentRuntime, parseSystemAgentProposal, runSystemAgentProtocol,
  systemAgentChildEnvironment, systemAgentProfilePatch, SYSTEM_AGENT_TOOL_GUARD_MODULE,
} from '../dist/system-agent-runtime.js';
import { SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS, SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES } from '../dist/system-agent-guidance.js';

const input = { jobCode: 'JOB1', document: { code: 'DOC1', revision: 3, title: 'Original', summary: '', content: '# Original' }, instruction: 'Clarify acceptance criteria.' };
const proposal = { title: 'Revised', summary: 'Summary', content: '# Revised\n\nAcceptance.', rationale: 'Clarified acceptance.', evidence: ['document:DOC1@3'], warnings: ['Business owner review required.'] };
const runOptions = { prompt: 'test', cwd: process.cwd(), model: 'deepseek-flash', maxTokens: 512, timeoutMs: 3000 };

async function removeTestDirectory(path) {
  const target = resolve(path), child = relative(resolve(tmpdir()), target);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && basename(target).startsWith('team-synergy-'));
  await rm(target, { recursive: true, force: true });
}

function childFor(behavior = 'success') {
  const source = `
    const readline = require('node:readline');
    const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const reply = (id, result) => write({ jsonrpc:'2.0', id, result });
    const event = (sessionId, type, data) => write({ jsonrpc:'2.0', method:'session.event', params:{ sessionId,event:{type,data} } });
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line), behavior=${JSON.stringify(behavior)};
      if(request.method==='shutdown' && behavior==='flush') { setTimeout(() => process.stderr.write('FLUSHED\\n'), 100); return; }
      if (request.method==='initialize') {
        if(behavior==='timeout') return;
        if(behavior==='malformed') { process.stdout.write('not JSON\\n'); return; }
        if(behavior==='exit') { process.exit(2); return; }
        reply(request.id, {serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}); return;
      }
      if(request.method!=='session/prompt') return;
      const sessionId=request.params.sessionId;
      if(behavior!=='early') reply(request.id,{messageId:'m1'});
      event(sessionId,'agent/inbox/spliced',{inserted:[{id:'m1'}]});
      if(behavior==='tool') { event(sessionId,'tool/call',{name:'pwsh'}); return; }
      event(sessionId,'assistant/message',{message:{content:[{type:'text',text:${JSON.stringify(JSON.stringify(proposal))}}]}});
      event(sessionId,'turn/end',{reason:{kind:behavior==='limit'?'max-tokens':'completed'}});
      write({jsonrpc:'2.0',method:'session.status',params:{sessionId,status:'idle'}});
      if(behavior==='early') reply(request.id,{messageId:'m1'});
    });
  `;
  return spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

test('runtime is off until explicitly configured', () => {
  assert.equal(createSystemAgentRuntime({}).status().configured, false);
  assert.match(createSystemAgentRuntime({}).status().message, /尚未启用/);
});

test('child environment removes platform credentials and user startup hooks', () => {
  const env = systemAgentChildEnvironment({ PATH: 'path', DATABASE_URL: 'db-secret', TSP_DEVICE_TOKEN: 'token', NODE_OPTIONS: '--require evil', DSH_HOME: 'personal', OPENAI_API_KEY: 'other-key', HOME: 'personal' }, '/isolated/home', '/isolated/tmp', 'provider-key');
  assert.equal(env.DEEPSEEK_API_KEY, 'provider-key');
  assert.equal(env.DSH_HOME, '/isolated/home');
  assert.equal(env.HOME, '/isolated/home');
  for (const key of ['DATABASE_URL', 'TSP_DEVICE_TOKEN', 'NODE_OPTIONS', 'OPENAI_API_KEY']) assert.equal(env[key], undefined);
});

test('proposal parser accepts exact snapshot references and rejects fabricated evidence/invalid structure', () => {
  assert.deepEqual(parseSystemAgentProposal(JSON.stringify(proposal), input), proposal);
  assert.throws(() => parseSystemAgentProposal(JSON.stringify({ ...proposal, evidence: ['document:OTHER@1'] }), input), error => error.code === 'invalid_output');
  assert.throws(() => parseSystemAgentProposal(JSON.stringify({ ...proposal, content: '' }), input), error => error.code === 'invalid_output');
  assert.throws(() => parseSystemAgentProposal('not-json', input), error => error.code === 'invalid_output');
});

test('tool guard denies every execution and prevents an agent with unexpected tool schemas', async () => {
  const { apply } = await import(`data:text/javascript,${encodeURIComponent(SYSTEM_AGENT_TOOL_GUARD_MODULE)}`);
  let guard, created;
  const ctx = { tools: { guard: callback => { guard = callback; }, schemas: () => [] }, on: (_name, callback) => { created = callback; } };
  apply(ctx);
  assert.match(guard({}), /does not permit tools/);
  created({ agent: {} });
  ctx.tools.schemas = () => [{ name: 'pwsh' }];
  assert.throws(() => created({ agent: {} }), /Unexpected model tools/);
});

for (const behavior of ['success', 'early']) test(`DSH protocol requires completed turn and handles ${behavior} notification ordering`, async () => {
  const child = childFor(behavior);
  const result = await runSystemAgentProtocol(child, runOptions);
  assert.deepEqual(JSON.parse(result), proposal);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'child must be reaped');
});

test('successful teardown allows the runtime to flush durable results before exit', async () => {
  const child = childFor('flush');
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  await runSystemAgentProtocol(child, runOptions);
  assert.equal(diagnostics, 'FLUSHED\n');
  assert.equal(child.exitCode, 0);
});

for (const [behavior, code] of [['malformed', 'protocol_error'], ['exit', 'engine_error'], ['limit', 'engine_error'], ['tool', 'protocol_error']]) test(`DSH protocol rejects ${behavior} without publishing a draft`, async () => {
  const child = childFor(behavior);
  await assert.rejects(runSystemAgentProtocol(child, runOptions), error => error.code === code && (behavior !== 'limit' || error.engineReason === 'max-tokens'));
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'child must be reaped');
});

test('timeout and explicit cancellation stop the owned process', async () => {
  const timeoutChild = childFor('timeout');
  await assert.rejects(runSystemAgentProtocol(timeoutChild, { ...runOptions, timeoutMs: 100 }), error => error.code === 'timeout');
  assert.ok(timeoutChild.exitCode !== null || timeoutChild.signalCode !== null);
  const cancelledChild = childFor('timeout');
  const controller = new AbortController();
  const waiting = runSystemAgentProtocol(cancelledChild, { ...runOptions, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(waiting, error => error.code === 'cancelled');
  assert.ok(cancelledChild.exitCode !== null || cancelledChild.signalCode !== null);
});

test('configured runtime rejects oversized input before creating a child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-synergy-config-'));
  try {
    const install = join(root, 'install');
    await mkdir(join(install, 'lib'), { recursive: true });
    await writeFile(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
    await writeFile(join(install, 'lib', 'bin.js'), 'process.exit(99)');
    const runtime = createSystemAgentRuntime({ TSP_SYSTEM_AGENT_ENABLED: 'true', TSP_SYSTEM_AGENT_DSH_BIN: join(install, 'lib', 'bin.js'), TSP_SYSTEM_AGENT_WORKSPACE_ROOT: join(root, 'work'), TSP_SYSTEM_AGENT_API_KEY: 'test-only-key' });
    assert.equal(runtime.status().configured, true);
    await assert.rejects(runtime.generate({ ...input, guidance: 'x'.repeat(SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS + 1) }), error => error.code === 'invalid_input');
    await assert.rejects(runtime.generate({ ...input, guidance: '中'.repeat(Math.floor(SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES / 3) + 1) }), error => error.code === 'invalid_input');
  } finally { await removeTestDirectory(root); }
});

test('installed pinned DSH boots the restricted profile with no advertised tools (no model invocation)', { skip: !process.env.TSP_SYSTEM_AGENT_TEST_DSH_BIN }, async () => {
  const bin = process.env.TSP_SYSTEM_AGENT_TEST_DSH_BIN;
  const root = await mkdtemp(join(tmpdir(), 'team-synergy-dsh-probe-'));
  try {
    const guard = join(root, 'guard.mjs'), patch = join(root, 'patch.yml'), home = join(root, 'home');
    await mkdir(home);
    await writeFile(guard, SYSTEM_AGENT_TOOL_GUARD_MODULE);
    await writeFile(patch, systemAgentProfilePatch(guard));
    const env = systemAgentChildEnvironment(process.env, home, root, 'not-a-real-key');
    const dump = spawn(process.execPath, [bin, '--profile', 'sdk-minimal', '--patch', patch, '--dump-config'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    dump.stdout.on('data', chunk => { stdout += chunk; }); dump.stderr.on('data', chunk => { stderr += chunk; }); dump.stdin.end();
    const code = await new Promise((resolve, reject) => { dump.once('close', resolve); dump.once('error', reject); });
    assert.equal(code, 0, stderr.slice(0, 300));
    const yaml = createRequire(bin)('yaml');
    const entries = yaml.parse(stdout, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    assert.ok(Array.isArray(entries));
    const toolRows = entries.filter(row => /dsh-(?:tool-|mcp-resources)/.test(row.name ?? '') && row.disabled !== true);
    assert.deepEqual(toolRows.map(row => row.id), []);
    assert.equal(entries.find(row => row.id === 'sandbox-policy').config.mode, 'read-only');
    const child = spawn(process.execPath, [bin, '--profile', 'sdk-minimal', '--patch', patch], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const initialized = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH initialization timed out')), 20000);
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.id === 1) { clearTimeout(timer); frame.error ? reject(new Error('DSH initialization failed')) : resolve(frame.result); }
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); reject(new Error(`DSH exited: ${code}`)); });
    });
    child.stderr.resume();
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: root, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 512 } }) + '\n');
      assert.equal((await initialized).serverInfo.name, 'deepseek-harness-sdk-runtime');
    } finally {
      const exited = new Promise(resolve => child.once('close', resolve));
      child.stdin.end(); child.kill(); await exited;
    }
  } finally { await removeTestDirectory(root); }
});

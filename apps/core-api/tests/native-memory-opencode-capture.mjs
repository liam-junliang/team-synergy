// Importing is inert. All user input goes to the real OpenCode server; only
// its installed plugin stages/confirms/delivers memory to the platform.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { opencodeNativePluginSource } from '../../cli/dist/memory-opencode-capture.js';
import { evaluationProvider } from './native-memory-opencode.mjs';

const cliPath = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);

export async function withNativeOpenCodeCapture({ member, dir, memorySession, owner, system, mcpArgs,
  auditFile, allowModel = false }, work) {
  assert.ok(nativeId(memorySession) && /^[a-f0-9]{64}$/u.test(owner));
  const provider = evaluationProvider();
  if (allowModel) assert.equal(provider.model, 'workbuddy/deepseek-v4.1-flash');
  const parent = await realpath(dir), profile = await mkdtemp(path.join(parent, 'opencode-native-capture-'));
  const program = process.env.TSP_PROBE_OPENCODE || path.join(process.env.APPDATA,
    'npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe');
  const password = randomBytes(24).toString('hex');
  const env = {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
    HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    PROGRAMDATA: profile, TEMP: profile, TMP: profile, OPENCODE_TEST_HOME: profile,
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_DATA_HOME: path.join(profile, 'data'), XDG_STATE_HOME: path.join(profile, 'state'),
    // A fresh native plugin profile must let OpenCode install its own pinned
    // plugin SDK from the official registry. Provider traffic stays loopback.
    NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', GIT_CONFIG_NOSYSTEM: '1',
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password,
    ...(provider.gateway ? { TSP_EVAL_GATEWAY_TOKEN: process.env.TSP_EVAL_GATEWAY_TOKEN } : {}),
  };
  const config = {
    model: 'local/' + provider.alias, small_model: 'local/' + provider.alias, enabled_providers: ['local'],
    autoupdate: false, share: 'disabled', snapshot: false, lsp: false, formatter: false,
    permission: { '*': 'deny', 'tsp_memory_*': 'allow' },
    agent: { member: { mode: 'primary', prompt: system, temperature: 0, steps: 6 } },
    provider: { local: { npm: '@ai-sdk/openai-compatible', name: provider.name,
      ...(provider.gateway ? { env: ['TSP_EVAL_GATEWAY_TOKEN'] } : {}),
      options: { baseURL: provider.baseURL, ...(provider.gateway ? {} : { apiKey: 'local-test' }), timeout: 90000 },
      models: { [provider.alias]: { id: provider.model, name: provider.model, tool_call: true, limit: { context: 16384, output: 3072 } } },
    } },
    mcp: { tsp_memory: { type: 'local', command: [process.execPath, ...(mcpArgs ?? [cliPath, 'memory', 'mcp'])],
      environment: { AGENTCTL_HOME: member.home, TSP_MEMORY_SESSION: memorySession, TSP_EVAL_GATEWAY_TOKEN: '', OPENCODE_CONFIG_CONTENT: '' }, timeout: 15000 } },
  };
  let proc, closed, base, sessionId, phase = 'profile_setup';
  const trace = [];
  const stop = async () => {
    if (!proc || !closed) return;
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await closed;
    proc = undefined; closed = undefined;
  };
  const start = async () => {
    const childEnv = { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    proc = spawn(program, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: member.cwd, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(proc, 'close');
    proc.stderr.resume();
    let stdout = '';
    const address = new Promise((resolve, reject) => {
      proc.stdout.setEncoding('utf8').on('data', value => {
        stdout += value;
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);
        if (match) resolve(match[1]);
      });
      proc.once('error', () => reject(Error('opencode_native_server_start_failed')));
      proc.once('close', () => reject(Error('opencode_native_server_exited_before_ready')));
    });
    const timer = setTimeout(() => proc?.kill(), 45000);
    try { base = await address; } finally { clearTimeout(timer); }
  };
  const request = async (method, endpoint, body, timeoutMs = 20000) => {
    const url = new URL(endpoint, base); url.searchParams.set('directory', member.cwd);
    const at = Date.now();
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    trace.push({ method, endpoint: endpoint.replace(/ses_[^/]+/gu, ':session').replace(/msg_[^/]+/gu, ':message'),
      status: response.status, latencyMs: Date.now() - at });
    assert.equal(response.status, 200, 'opencode_native_http_' + response.status);
    return response.json();
  };
  try {
    for (const folder of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) await mkdir(folder);
    const version = execFileSync(program, ['--version'], { cwd: member.cwd, env, windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim();
    assert.equal(version, '1.14.21');
    // A native session is created without a prompt/model before the fixed
    // single-session plugin is installed. The same profile is reused below.
    phase = 'bootstrap_server_start'; await start();
    phase = 'bootstrap_native_session_create';
    const session = await request('POST', '/session', { title: 'TSP native capture verification' });
    assert.ok(nativeId(session.id)); sessionId = session.id;
    await stop(); phase = 'plugin_source_write';
    const options = { harness: 'opencode', hostSessionId: sessionId, memorySession, owner, cwd: member.cwd,
      memberHome: member.home, cliPath, nodePath: process.execPath, ...(auditFile ? { auditFile } : {}) };
    const pluginFile = path.join(profile, 'tsp-native-capture.mjs');
    await writeFile(pluginFile, opencodeNativePluginSource(options), { mode: 0o600 });
    config.plugin = [pathToFileURL(pluginFile).href];
    phase = 'native_plugin_server_start'; await start();
    phase = 'native_plugin_session_load';
    await request('GET', '/session/' + sessionId, undefined, 90000);
    let turns = 0;
    const send = async (prompt, noReply) => {
      assert.equal(typeof prompt, 'string');
      if (!noReply) assert.equal(allowModel, true, 'native_probe_model_calls_need_explicit_opt_in');
      const result = await request('POST', '/session/' + sessionId + '/message', {
        agent: 'member', model: { providerID: 'local', modelID: provider.alias },
        ...(noReply ? { noReply: true } : {}), parts: [{ type: 'text', text: prompt }],
      }, noReply ? 30000 : 180000);
      const messages = await request('GET', '/session/' + sessionId + '/message');
      const user = messages.findLast(message => message.info?.role === 'user');
      assert.ok(user && nativeId(user.info.id));
      const original = user.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text).join('\n');
      assert.equal(original, prompt, 'native_saved_user_text_changed');
      turns++;
      return { turn: turns, nativeMessageId: user.info.id,
        answer: noReply ? '' : (result.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'),
        calls: noReply ? [] : messages.filter(message => message.info?.parentID === user.info.id)
          .flatMap(message => message.parts.filter(part => part.type === 'tool').map(part => part.tool)), noReply };
    };
    phase = 'native_host_work';
    return await work({ sessionId, version, trace, options, turn: prompt => send(prompt, false), record: prompt => send(prompt, true),
      readNativeMessage: messageID => request('GET', '/session/' + sessionId + '/message/' + messageID),
      restart: async () => { await stop(); await start(); await request('GET', '/session/' + sessionId); await delay(30); } });
  } catch (error) {
    // Native logs/HTTP errors may contain provider data. Expose only a fixed
    // error identifier to the outer public experiment report.
    throw Object.assign(Error('opencode_native_capture_probe_failed'), { causeCode: error?.code ?? error?.name ?? 'unknown', phase, trace });
  } finally {
    await stop();
    const target = await realpath(profile);
    assert.equal(path.dirname(target), parent); assert.match(path.basename(target), /^opencode-native-capture-[a-zA-Z0-9]+$/u);
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

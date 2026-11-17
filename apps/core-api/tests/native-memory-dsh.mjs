// Opt-in live member harness. Only the harness and its MCP child see their own isolated homes.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const pinnedVersion = '0.2.1-rc.2';
const disabled = ['tool-fs', 'tool-working-directory', 'subprocess', 'pty',
  'terminal-pwsh', 'terminal-bash', 'persistent-pwsh', 'persistent-bash', 'compaction-basic', 'image-offload'];

export function createDshEvalPatch(member, mcpArgs, gateway, model, system, headless, maxTokens) {
  const memory = {
    id: 'tsp-memory', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'tsp_memory', transport: 'stdio', command: process.execPath,
      cwd: member.cwd, args: mcpArgs,
      env: { AGENTCTL_HOME: member.home, DEEPSEEK_API_KEY: '', TSP_EVAL_GATEWAY_TOKEN: '' }, failOnStartupError: true,
    }
  };
  const common = [
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: member.cwd } },
    { id: 'llm-deepseek', config: { baseURL: gateway.origin, apiKeyEnv: 'DEEPSEEK_API_KEY', thinking:'disabled',
      maxTokens, models:[{id:model,name:model,inputModalities:['text']}],
      streamIdleTimeoutMs:60000, retryPolicy:{mode:'normal',maxRetries:0} } },
  ];
  if (!headless) return JSON.stringify([
    ...disabled.map(id => ({ id, disabled: true })), ...common,
    { insert: [memory] },
  ]);
  // Headless composes dsh-base, which already mounts the official Messages adapter. Leave
  // its real CLI lifecycle and resource tools in place; isolate the member's other capabilities.
  const excluded = ['llm-pi-ai','llm-deepseek-account', 'agent-instructions', 'remote-access', 'session-title-llm',
    'tool-plugin-manager', 'tool-working-directory', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill',
    'tool-workflow', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'tool-todo',
    'tool-goal', 'tool-web', 'web-deepseek-api', 'web-search-deepseek', 'web-fetch-http', 'session-telemetry-otel'];
  return JSON.stringify([...excluded.map(id => ({ id, disabled: true })), ...common,
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
  { id: 'system-prompt', config: { personaPrefix: system, includeRuntimeContext: false, includeHarnessIdentity: false } }, { insert: [memory] }]);
}

export async function runCase({ member, prompt, system, mcpArgs, dir, maxTokens=1024, turnTimeoutMs=95000, maxToolCalls=12 }) {
  assert.ok(Number.isInteger(maxTokens) && maxTokens>=256 && maxTokens<=8192);
  assert.ok(Number.isInteger(turnTimeoutMs) && turnTimeoutMs>0 && turnTimeoutMs<=240000);
  assert.ok(Number.isInteger(maxToolCalls) && maxToolCalls>0 && maxToolCalls<=24);
  const installed = process.env.TSP_PROBE_DSH_BIN || path.join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.ok(path.isAbsolute(installed), 'Set TSP_PROBE_DSH_BIN to the absolute path of the installed DSH lib/bin.js.');
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(installed), '../package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh');
  assert.equal(manifest.version, pinnedVersion, 'Revalidate the DSH SDK and provider schema for a new version.');
  const gateway = new URL(process.env.TSP_EVAL_GATEWAY_URL || 'about:blank');
  assert.ok(gateway.protocol==='http:' && gateway.hostname==='127.0.0.1' && gateway.port &&
    /^\/v1\/?$/.test(gateway.pathname) && !gateway.search && !gateway.hash && !gateway.username && !gateway.password,
    'Use the dedicated loopback DeepSeek evaluation gateway');
  const localToken = process.env.TSP_EVAL_GATEWAY_TOKEN;
  assert.ok(localToken, 'Missing ephemeral gateway credential');
  const model = process.env.TSP_EVAL_MODEL;
  assert.ok(typeof model==='string' && /^(?:[a-z0-9][a-z0-9._-]*\/)?(?:deepseek-flash|deepseek-v4\.1-flash(?:-1017)?)$/i.test(model),
    'Pin the exact DeepSeek V4.1 Flash model route before starting DSH');
  const headless = process.env.TSP_PROBE_DSH_PROFILE === 'headless';
  if (process.env.TSP_PROBE_DSH_GUIDANCE === 'product') {
    assert.ok(mcpArgs.includes('guided'),'Run the DSH-specific guidance arm only with the enabled MCP capabilities');
    const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
    system = execFileSync(process.execPath,[cli,'memory','guidance','--harness','dsh'],{encoding:'utf8',timeout:5000,windowsHide:true}).trim();
  }
  const home = await mkdtemp(path.join(dir, 'tsp-dsh-'));
  const overlay = path.join(home, 'member.patch.yml');
  let proc;
  let done;
  let timeout;
  let receivedFinal = false;
  try {
    await writeFile(overlay, createDshEvalPatch(member, mcpArgs, gateway, model, system, headless, maxTokens), { mode: 0o600 });
    const env = {
      DSH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      TEMP: home, TMP: home, DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', DSH_PRIMARY_RUNTIME: '',
      DSH_SYSTEM_PROMPT: system, DEEPSEEK_BASE_URL:gateway.origin, DEEPSEEK_API_KEY:localToken, NO_PROXY:'127.0.0.1,localhost'
    };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    const args = [installed, '--profile', headless ? 'headless' : 'sdk-minimal', '--patch', overlay];
    if (headless) args.push('--json', prompt);
    proc = spawn(process.execPath, args, {
      cwd: member.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    done = once(proc, 'close');
    // Never emit child stderr, which can contain full member prompts or transport payloads.
    proc.stderr.resume();
    timeout = setTimeout(() => proc.kill(), turnTimeoutMs);
    const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const send = (id, method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const sessionId = 'memory-' + randomUUID();
    const calls = [];
    let answer = '';
    if (headless) proc.stdin.end();
    else send(1, 'initialize', { cwd: member.cwd, provider:'deepseek-official', model, maxTokens });
    while (true) {
      const line = await lines.next();
      if (line.done) throw Error('DSH terminated before completing its turn');
      // This SDK release writes these two client diagnostics to stdout on a tools-only server.
      if (/^Client\.list(?:Resources|ResourceTemplates)\(\) called but server does not advertise resources capability - returning empty list$/.test(line.value)) continue;
      const frame = JSON.parse(line.value);
      if (headless) {
        if (frame.type === 'tool_call') {
          calls.push(frame.tool);
          if (process.env.TSP_EVAL_TRACE === '1') {
            // Only these non-content fields are included in this synthetic-fixture diagnostic.
            const args = frame.input ?? {};
            process.stderr.write(JSON.stringify({ dshTool: frame.tool, scope: args.scope, server: args.server, uri: args.uri }) + '\n');
          }
          if (calls.length > maxToolCalls) throw Error('DSH exceeded the probe tool budget');
        }
        if (frame.type === 'error') throw Error('DSH headless failed: ' + String(frame.code || 'error'));
        if (frame.type === 'final') {
          receivedFinal = true;
          return { answer: frame.text, calls, version: manifest.version + ' headless' };
        }
        continue;
      }
      if (frame.error) throw Error('DSH rejected RPC ' + frame.id + ' (' + frame.error.code + ')');
      if (frame.id === 1) {
        assert.equal(frame.result?.serverInfo?.name, 'deepseek-harness-sdk-runtime');
        send(2, 'session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
      }
      if (frame.method !== 'session.event' || frame.params.sessionId !== sessionId) continue;
      const { type, data } = frame.params.event;
      if (type === 'tool/call') {
        calls.push(data.name);
        if (calls.length > maxToolCalls) throw Error('DSH exceeded the probe tool budget');
      } else if (type === 'assistant/message') {
        answer = (data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
      } else if (type === 'turn/end') {
        if (data.reason?.kind !== 'completed') throw Error('DSH ended with ' + data.reason?.kind + ' ' + (data.reason?.error?.code || data.reason?.code || ''));
        receivedFinal = true;
        return { answer, calls, version: manifest.version };
      }
    }
  } finally {
    clearTimeout(timeout);
    let exitCode;
    if (proc && done) {
      if (!headless && !proc.stdin.destroyed && proc.exitCode === null && proc.signalCode === null) {
        proc.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} }) + '\n');
      }
      const reap = setTimeout(() => proc.kill(), 4000);
      try { [exitCode] = await done; } finally { clearTimeout(reap); }
    }
    assert.equal(path.dirname(home), path.resolve(dir));
    assert.match(path.basename(home), /^tsp-dsh-[a-zA-Z0-9]+$/);
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    if (receivedFinal) assert.equal(exitCode, 0, 'DSH completed its turn but failed during shutdown');
  }
}

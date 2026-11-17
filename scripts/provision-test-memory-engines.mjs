// Dedicated native integration services. Never imports a business deployment/config.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, lstatSync, readdirSync, symlinkSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const runtimeRoot = path.resolve('F:/workspace/team-synergy-runtime/test-memory-engines');
const script = fileURLToPath(import.meta.url);
const tencentSource = path.resolve('F:/workspace/team-knowledge-runtime/tencent/source');
const tencentLauncher = path.resolve('F:/workspace/team-knowledge-hub/scripts/deploy-tencent.mjs');
const ovExe = path.resolve('F:/workspace/team-knowledge-runtime/openviking/.venv/Scripts/openviking-server.exe');
function ovPythonExecutable() {
  const cfg = readFileSync(path.resolve(path.dirname(ovExe), '../pyvenv.cfg'), 'utf8');
  const home = /^home\s*=\s*(.+)$/mu.exec(cfg)?.[1].trim();
  check(home && path.isAbsolute(home), 'python_home_unknown');
  return path.join(home, 'python.exe');
}
const powershell = path.resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
export const ports = Object.freeze({ core: 18520, knowledge: 18524, openviking: 21933 });
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifestFile = path.join(runtimeRoot, 'manifest.private.json');
const privateFile = path.join(runtimeRoot, 'engines.private.json');
const confFile = path.join(runtimeRoot, 'openviking/ov.conf');
const deploymentFile = path.join(runtimeRoot, 'tencent/deployment.json');
const pendingFile = path.join(runtimeRoot, 'bootstrap.pending.private.json');
const run = (exe, args, env) => execFileSync(exe, args, { encoding: 'utf8', windowsHide: true,
  timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) }).trim();
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function check(value, code) { if (!value) throw Object.assign(Error(code), { code }); }
function normalized(value) { return path.resolve(value).toLowerCase(); }
function controlEnvironment(extra = {}) {
  return { ...Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]])), ...extra };
}

export function assertOwnedPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  check(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), 'path_outside_test_runtime');
  return path.resolve(target);
}

export function isolatedEnvironment(root, ambient = process.env) {
  // Deliberately omit DB URLs, TDAI/OV overrides, NODE_OPTIONS and user config variables.
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATH', 'Path', 'PATHEXT',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER']) {
    if (ambient[key]) env[key] = ambient[key];
  }
  return { ...env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'home/AppData/Roaming'), LOCALAPPDATA: path.join(root, 'home/AppData/Local'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1', NO_COLOR: '1', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
}

export function validateManifest(value, expectedRoot = runtimeRoot) {
  check(value?.version === 1 && value.purpose === 'team-synergy-test-memory-engines' &&
    normalized(value.runtimeRoot) === normalized(expectedRoot) && /^[0-9a-f]{64}$/u.test(value.nonce), 'unknown_test_runtime');
  check(JSON.stringify(value.ports) === JSON.stringify(ports), 'unexpected_test_ports');
  check(normalized(value.tencentSource) === normalized(tencentSource) && normalized(value.tencentLauncher) === normalized(tencentLauncher)
    && normalized(value.openvikingExecutable) === normalized(ovExe), 'unexpected_program_paths');
  return value;
}

function load() {
  check(existsSync(manifestFile), 'test_runtime_not_provisioned');
  const state = validateManifest(json(manifestFile));
  check(!lstatSync(runtimeRoot).isSymbolicLink() && normalized(realpathSync.native(runtimeRoot)) === normalized(runtimeRoot), 'runtime_is_redirected');
  for (const dir of ['tencent', 'tencent/data', 'openviking', 'openviking/data', 'home', 'temp', 'logs']) {
    const target = assertOwnedPath(runtimeRoot, path.join(runtimeRoot, dir));
    check(existsSync(target) && !lstatSync(target).isSymbolicLink() && normalized(realpathSync.native(target)) === normalized(target), 'data_path_is_redirected');
  }
  check(normalized(realpathSync.native(path.join(runtimeRoot, 'tencent/source'))) === normalized(realpathSync.native(tencentSource)), 'source_junction_changed');
  const deployment = json(deploymentFile), conf = json(confFile);
  check(deployment.coreBaseUrl === 'http://127.0.0.1:18520/v3' && deployment.knowledgeBaseUrl === 'http://127.0.0.1:18524/v3' &&
    normalized(deployment.dataDir) === normalized(path.join(runtimeRoot, 'tencent/data')) && deployment.serviceId === 'default', 'tencent_config_identity_changed');
  check(conf.server?.port === ports.openviking && conf.server.host === '127.0.0.1' && conf.server.auth_mode === 'api_key' &&
    normalized(conf.storage.workspace) === normalized(path.join(runtimeRoot, 'openviking/data')) &&
    conf.storage.agfs.backend === 'local' && conf.storage.vectordb.backend === 'local', 'openviking_config_identity_changed');
  check(state.configHashes.tencent === sha256(readFileSync(deploymentFile)) && state.configHashes.openviking === sha256(readFileSync(confFile)), 'test_config_changed');
  if (state.enginesFileHash) {
    check(existsSync(privateFile) && state.enginesFileHash === sha256(readFileSync(privateFile)), 'exported_test_config_changed');
    const exported = json(privateFile);
    check(exported.testIsolation?.nonce === state.nonce && normalized(exported.testIsolation.runtimeRoot) === normalized(runtimeRoot) &&
      exported.tencent.coreBaseUrl === deployment.coreBaseUrl && exported.tencent.baseUrl === deployment.knowledgeBaseUrl &&
      exported.openviking.baseUrl === 'http://127.0.0.1:21933', 'exported_test_config_identity_changed');
  }
  return { state, deployment, conf };
}

// Only requested listeners/processes are emitted; no environment, keys, unrelated command lines or logs.
function processSnapshot(pids = [], lineage = false) {
  const command = `
$ErrorActionPreference='Stop'
$wantedPorts=@(18520,18524,21933)
$wantedPids=@($env:TSP_ENGINE_CONTROL_PIDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $wantedPorts } | ForEach-Object { [pscustomobject]@{port=[int]$_.LocalPort;address=$_.LocalAddress;pid=[int]$_.OwningProcess} })
$ids=@($wantedPids)+@($listeners | ForEach-Object { $_.pid }) | Select-Object -Unique
$rows=@(foreach($targetPid in $ids) { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$targetPid); if($p) { [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=$p.Name;executable=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');commandLine=$p.CommandLine} } })
$ancestry=@()
if($env:TSP_ENGINE_CONTROL_LINEAGE -eq '1') { $ancestry=@(foreach($l in $listeners) { $nextPid=$l.pid; for($depth=0;$depth -lt 8;$depth++) { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$nextPid); if(-not $p) { break }; [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId}; if([int]$p.ParentProcessId -in $wantedPids) { break }; $nextPid=[int]$p.ParentProcessId; if($nextPid -le 0) { break } } }) }
@{listeners=$listeners;processes=$rows;ancestry=$ancestry} | ConvertTo-Json -Depth 5 -Compress
`;
  return JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command],
    controlEnvironment({ TSP_ENGINE_CONTROL_PIDS: pids.join(','), TSP_ENGINE_CONTROL_LINEAGE: lineage ? '1' : '0' })));
}

export function descendantOf(ancestry, child, ancestor) {
  const seen = new Set();
  while (child && child !== ancestor && !seen.has(child)) {
    seen.add(child); child = ancestry.find(row => row.pid === child)?.parentPid;
  }
  return child === ancestor;
}

export function processIdentityMatches(actual, recorded) {
  return Boolean(actual && recorded && actual.pid === recorded.pid && actual.createdAt === recorded.createdAt &&
    normalized(actual.executable) === normalized(recorded.executable) && sha256(actual.commandLine ?? '') === recorded.commandHash);
}
function safeIdentity(row) { return { pid: row.pid, createdAt: row.createdAt, executable: row.executable, commandHash: sha256(row.commandLine ?? '') }; }
function expectedCommand(kind, row) {
  const command = row?.commandLine?.replaceAll('\\', '/').toLowerCase() ?? '';
  if (kind === 'openviking') return command.includes(confFile.replaceAll('\\', '/').toLowerCase()) && command.includes('21933') &&
    [path.join(path.dirname(ovExe), 'python.exe'), ovPythonExecutable()].some(exe => normalized(row.executable) === normalized(exe)) &&
    command.includes(ovExe.replaceAll('\\', '/').toLowerCase());
  return normalized(row.executable) === normalized(process.execPath) &&
    command.includes(script.replaceAll('\\', '/').toLowerCase()) && command.includes('serve-' + kind);
}
function verifyProcesses(state, { allowStopped = false } = {}) {
  const snapshot = processSnapshot(Object.values(state.processes).flatMap(p => [p.pid, p.launcher?.pid].filter(Boolean)));
  for (const [kind, port] of Object.entries(ports)) {
    const listeners = snapshot.listeners.filter(row => row.port === port);
    const expected = state.processes[kind];
    if (!listeners.length && allowStopped) {
      check(!expected || !snapshot.processes.some(row => row.pid === expected.pid), 'owned_process_alive_without_listener');
      continue;
    }
    check(expected && listeners.length === 1 && listeners[0].address === '127.0.0.1' && listeners[0].pid === expected.pid, 'unknown_test_listener');
    const actual = snapshot.processes.find(row => row.pid === expected.pid);
    check(processIdentityMatches(actual, expected) && expectedCommand(kind, actual), 'service_process_identity_changed');
  }
  return snapshot;
}

async function initialize() {
  check(process.platform === 'win32', 'windows_required');
  if (existsSync(manifestFile)) return load().state;
  if (existsSync(runtimeRoot)) {
    check(existsSync(pendingFile), 'unknown_existing_test_directory');
    const pending = json(pendingFile);
    check(pending.purpose === 'team-synergy-test-memory-engines-bootstrap' && normalized(pending.runtimeRoot) === normalized(runtimeRoot)
      && /^[0-9a-f]{64}$/u.test(pending.nonce), 'unknown_bootstrap_marker');
    assertEmptyBootstrapTree(true);
  }
  check(processSnapshot().listeners.length === 0, 'test_port_in_use');
  for (const file of [tencentLauncher, path.join(tencentSource, 'MemoryCore/node_modules/tsx/dist/loader.mjs'),
    path.join(tencentSource, 'MemoryKnowledge/dist/server.mjs'), ovExe]) check(existsSync(file), 'required_program_missing');
  const agfsSchema = readFileSync(path.resolve(path.dirname(ovExe), '../Lib/site-packages/openviking_cli/utils/config/agfs_config.py'), 'utf8');
  check(agfsSchema.includes('Ignored by RAGFS.'), 'unreviewed_agfs_port_behavior');
  const sourceCommit = run('git', ['-C', tencentSource, 'rev-parse', 'HEAD']);
  if (!existsSync(runtimeRoot)) mkdirSync(runtimeRoot, { mode: 0o700 });
  if (!existsSync(pendingFile)) save(pendingFile, { purpose: 'team-synergy-test-memory-engines-bootstrap', runtimeRoot,
    nonce: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() });
  const owner = run('whoami.exe', []);
  run('icacls.exe', [runtimeRoot, '/inheritance:r', '/grant:r', owner + ':(OI)(CI)F', '/q']);
  for (const dir of ['tencent/data', 'openviking/data', 'home/AppData/Roaming', 'home/AppData/Local', 'temp', 'logs'])
    mkdirSync(assertOwnedPath(runtimeRoot, path.join(runtimeRoot, dir)), { recursive: true, mode: 0o700 });
  symlinkSync(tencentSource, path.join(runtimeRoot, 'tencent/source'), 'junction');
  const deployment = { sourceCommit, coreBaseUrl: 'http://127.0.0.1:18520/v3', knowledgeBaseUrl: 'http://127.0.0.1:18524/v3',
    serviceId: 'default', token: randomBytes(32).toString('hex'),
    llm: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'hub-qwen2.5', maxTokens: 4096, timeoutMs: 300000 },
    embedding: { enabled: true, provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'bge-m3', dimensions: 1024, sendDimensions: false },
    dataDir: path.join(runtimeRoot, 'tencent/data'), accounts: {}, projects: {}, pids: {} };
  const conf = { server: { host: '127.0.0.1', port: ports.openviking, auth_mode: 'api_key', root_api_key: randomBytes(32).toString('hex') },
    storage: { workspace: path.join(runtimeRoot, 'openviking/data'), agfs: { backend: 'local' }, vectordb: { backend: 'local' } },
    embedding: { max_concurrent: 1, dense: { provider: 'openai', api_key: 'ollama', api_base: 'http://127.0.0.1:11435/v1',
      model: 'bge-m3', dimension: 1024, input: 'text', encoding_format: 'float', batch_size: 4 } },
    vlm: { provider: 'openai', api_key: 'ollama', api_base: 'http://127.0.0.1:11434/v1', model: 'hub-qwen2.5:latest',
      max_concurrent: 1, max_tokens: 2048, temperature: 0, timeout: 180 } };
  save(deploymentFile, deployment); save(confFile, conf);
  const state = { version: 1, purpose: 'team-synergy-test-memory-engines', runtimeRoot, nonce: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(), ports, tencentSource, tencentLauncher, openvikingExecutable: ovExe,
    sourceCommit, agfs: 'OV0.5.3 in-process RAGFS; legacy AGFS port ignored', processes: {},
    configHashes: { tencent: sha256(readFileSync(deploymentFile)), openviking: sha256(readFileSync(confFile)) },
    bootstrap: {} };
  save(manifestFile, state); return state;
}

function assertEmptyBootstrapTree(allowPending = false) {
  const allowed = new Set(['home', 'temp', 'home/AppData', 'home/AppData/Local', 'home/AppData/Roaming']);
  check(!lstatSync(runtimeRoot).isSymbolicLink() && normalized(realpathSync.native(runtimeRoot)) === normalized(runtimeRoot), 'runtime_is_redirected');
  const visit = base => {
    for (const row of readdirSync(base, { withFileTypes: true })) {
      const target = assertOwnedPath(runtimeRoot, path.join(base, row.name));
      const relative = path.relative(runtimeRoot, target).replaceAll('\\', '/');
      if (allowPending && relative === 'bootstrap.pending.private.json' && row.isFile()) continue;
      check(allowed.has(relative) && row.isDirectory() && !lstatSync(target).isSymbolicLink(), 'bootstrap_tree_is_not_empty');
      visit(target);
    }
  };
  visit(runtimeRoot);
}

async function health(kind) {
  try { return (await fetch('http://127.0.0.1:' + ports[kind] + '/health', { redirect: 'error', signal: AbortSignal.timeout(5000) })).ok; }
  catch { return false; }
}

async function start(state) {
  const before = processSnapshot(Object.values(state.processes).map(row => row.pid), Object.values(state.processes).some(row => row.starting));
  if (before.listeners.length) {
    // A Windows venv console launcher has a shim plus the real CPython child.
    // Recover only a recorded starting launcher with a proven descendant,
    // matching config argv and an allowlisted interpreter from pyvenv.cfg.
    for (const [kind, record] of Object.entries(state.processes)) {
      if (!record.starting) continue;
      const listener = before.listeners.find(row => row.port === ports[kind]);
      const actual = before.processes.find(row => row.pid === listener?.pid);
      check(descendantOf(before.ancestry, listener?.pid, record.pid) && processIdentityMatches(before.processes.find(row => row.pid === record.pid), record) &&
        expectedCommand(kind, actual) && actual.createdAt >= record.createdAt, 'starting_process_ownership_unproven');
      state.processes[kind] = { ...safeIdentity(actual), launcher: record.launcher }; save(manifestFile, state);
    }
    verifyProcesses(state); return;
  }
  check(before.processes.length === 0, 'owned_process_still_running');
  state.processes = {}; save(manifestFile, state);
  for (const kind of Object.keys(ports)) {
    check(processSnapshot().listeners.every(row => row.port !== ports[kind]), 'test_port_became_busy');
    const args = kind === 'openviking' ? ['--config', confFile, '--host', '127.0.0.1', '--port', String(ports.openviking)] :
      [...(kind === 'core' ? ['--import', pathToFileURL(path.join(tencentSource, 'MemoryCore/node_modules/tsx/dist/loader.mjs')).href] : []), script, 'serve-' + kind];
    const fd = openSync(path.join(runtimeRoot, 'logs/' + kind + '.private.log'), 'a', 0o600);
    let child;
    try { child = spawn(kind === 'openviking' ? ovExe : process.execPath, args, { cwd: runtimeRoot,
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...isolatedEnvironment(runtimeRoot),
        HUB_TENCENT_RUNTIME_DIR: path.join(runtimeRoot, 'tencent'), OPENVIKING_CONFIG_FILE: confFile } }); }
    finally { closeSync(fd); }
    check(child.pid > 0, 'spawn_failed'); child.unref();
    const launched = processSnapshot([child.pid]).processes.find(row => row.pid === child.pid);
    check(launched, 'launcher_exited_early');
    state.processes[kind] = { ...safeIdentity(launched), launcher: safeIdentity(launched), starting: true }; save(manifestFile, state);
    const deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline) {
      const snapshot = processSnapshot([child.pid], true);
      const listeners = snapshot.listeners.filter(row => row.port === ports[kind]);
      if (listeners.length) {
        const listener = listeners[0], processRow = snapshot.processes.find(row => row.pid === listener.pid);
        check(listeners.length === 1 && listener.address === '127.0.0.1' && expectedCommand(kind, processRow) &&
          descendantOf(snapshot.ancestry, listener.pid, child.pid) && processRow.createdAt >= launched.createdAt, 'new_listener_identity_mismatch');
        if (await health(kind)) { state.processes[kind] = { ...safeIdentity(processRow), launcher: safeIdentity(launched) }; save(manifestFile, state); ready = true; break; }
      }
      await delay(500);
    }
    check(ready, 'service_start_deadline');
  }
  verifyProcesses(state);
}

async function http(base, suffix, { key, serviceId, userKey, body, method = body === undefined ? 'GET' : 'POST', allow = [] } = {}) {
  const response = await fetch(base + suffix, { method, redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: { ...(key ? { [serviceId ? 'authorization' : 'x-api-key']: serviceId ? 'Bearer ' + key : key } : {}),
      ...(serviceId ? { 'x-tdai-service-id': serviceId } : {}), ...(userKey ? { 'x-tdai-user-key': userKey } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (allow.includes(response.status)) return { status: response.status, data: null };
  check(response.ok, 'http_' + response.status);
  const value = await response.json();
  check(serviceId ? value.code === 0 : value.status === 'ok', 'engine_rejected');
  return { status: response.status, data: serviceId ? value.data : value.result };
}

async function bootstrap(state, deployment, conf) {
  verifyProcesses(state);
  const core = (op, body, userKey) => http(deployment.coreBaseUrl, op, { key: deployment.token, serviceId: deployment.serviceId, body, userKey });
  const ov = (op, body, options = {}) => http('http://127.0.0.1:21933', op, { key: conf.server.root_api_key, body, ...options });
  const b = state.bootstrap;
  if (!b.admin) {
    b.adminKey ??= 'sk-mem-' + randomBytes(24).toString('hex'); save(manifestFile, state);
    const row = (await core('/internal/meta/user/init-admin', { username: 'tsp_test_admin', user_key: b.adminKey })).data;
    check(row.user_id, 'admin_bootstrap_failed'); b.admin = { userId: row.user_id, userKey: row.user_key || row.default_user_key || b.adminKey }; save(manifestFile, state);
  }
  if (!b.writer) {
    const row = (await core('/meta/user/create', { username: 'tsp_test_writer' }, b.admin.userKey)).data;
    check(row.user_id && row.default_user_key, 'writer_bootstrap_failed'); b.writer = { userId: row.user_id, userKey: row.default_user_key }; save(manifestFile, state);
  }
  if (!b.team) {
    const row = (await core('/meta/team/create', { name: 'tsp-isolated-integration-tests', owner_user_id: b.writer.userId }, b.writer.userKey)).data;
    check(row.team_id, 'team_bootstrap_failed'); b.team = row.team_id; save(manifestFile, state);
  }
  if (!b.agent) {
    const row = (await core('/meta/agent/create', { team_id: b.team, owner_user_id: b.writer.userId, name: 'tsp-test-semantic-index', visibility: 'private' }, b.writer.userKey)).data;
    check(row.agent_id, 'agent_bootstrap_failed'); b.agent = row.agent_id; save(manifestFile, state);
  }
  if (!b.ov) {
    const account = 'tsp-tests-' + state.nonce.slice(0, 16);
    const absent = await ov('/api/v1/admin/accounts/' + account, undefined, { allow: [404] });
    check(absent.status === 404, 'test_account_preexisted');
    const row = (await ov('/api/v1/admin/accounts', { account_id: account, admin_user_id: 'testadmin' })).data;
    check(row.account_id === account && row.user_key, 'ov_bootstrap_failed');
    b.ov = { accountId: account, adminApiKey: row.user_key, keySeed: randomBytes(32).toString('hex') }; save(manifestFile, state);
  }
  const config = { tencent: { baseUrl: deployment.knowledgeBaseUrl, coreBaseUrl: deployment.coreBaseUrl, token: deployment.token, serviceId: deployment.serviceId },
    openviking: { baseUrl: 'http://127.0.0.1:21933' }, projects: {}, accounts: {},
    projectProvisioning: { teamId: b.team, userId: b.writer.userId, semanticAgentId: b.agent }, personalProvisioning: b.ov,
    testIsolation: { version: 1, runtimeRoot, nonce: state.nonce, ports } };
  if (existsSync(privateFile)) {
    check(JSON.stringify(json(privateFile)) === JSON.stringify(config), 'exported_test_config_changed');
  } else save(privateFile, config);
  state.enginesFileHash = sha256(readFileSync(privateFile)); save(manifestFile, state);
}

async function probe(state, deployment, conf) {
  verifyProcesses(state);
  const b = state.bootstrap, runId = randomBytes(10).toString('hex');
  const report = { version: 1, runId, at: new Date().toISOString(), accepted: false,
    paths: { runtimeRoot, data: [deployment.dataDir, conf.storage.workspace] }, ports, checks: {}, cleanup: {},
    note: 'Synthetic test-scope transport/storage bootstrap only; no Agent model case and no throughput claim.' };
  const file = path.join(runtimeRoot, 'probe-' + runId + '.json');
  const content = '# 独立测试引擎\n\n本条仅验证隔离存储。方案已讨论，尚未确认，也未实施。标识 ' + runId;
  const ids = { team_id: b.team, user_id: b.writer.userId, agent_id: b.agent, task_id: 'test-probe-' + runId };
  const core = (op, body) => http(deployment.coreBaseUrl, '/conversation/' + op, { key: deployment.token, serviceId: deployment.serviceId, body: { ...ids, ...body } });
  const wiki = (op, body) => http(deployment.knowledgeBaseUrl, '/wiki/' + op, { key: deployment.token, serviceId: deployment.serviceId, body: { team_id: b.team, user_id: b.writer.userId, ...body } });
  const ov = (suffix, body, options = {}) => http('http://127.0.0.1:21933', suffix, { key: b.ov.adminApiKey, body, ...options });
  let coreRow, wikiId, user;
  try {
    for (const kind of Object.keys(ports)) report.checks[kind + 'Health'] = await health(kind);
    const added = (await core('add', { session_id: 'test-session-' + runId, messages: [{ role: 'assistant', content }] })).data;
    check(added.accepted_ids?.length === 1, 'core_probe_ack_missing'); coreRow = added.accepted_ids[0];
    const rows = (await core('query', { session_id: 'test-session-' + runId, limit: 2 })).data;
    check(rows.messages?.length === 1 && rows.messages[0].id === coreRow && sha256(rows.messages[0].content) === sha256(content), 'core_probe_readback_failed');
    report.checks.coreBodyHash = true;
    const made = (await wiki('create', { name: 'test-probe-' + runId })).data;
    check(made.wiki_id && made.team_id === b.team && made.owner_user_id === b.writer.userId, 'wiki_probe_identity_failed'); wikiId = made.wiki_id;
    await wiki('raw/write', { wiki_id: wikiId, files: [{ filename: 'probe.md', content, encoding: 'utf8' }] });
    const raw = (await wiki('raw/read', { wiki_id: wikiId, filenames: ['probe.md'] })).data;
    check(raw.items?.length === 1 && sha256(raw.items[0].content) === sha256(content), 'wiki_probe_readback_failed'); report.checks.wikiBodyHash = true;
    const userId = 'probe-' + runId;
    const created = (await ov('/api/v1/admin/accounts/' + b.ov.accountId + '/users', { user_id: userId, role: 'user' })).data;
    check(created.account_id === b.ov.accountId && created.user_id === userId && created.user_key, 'ov_probe_user_failed'); user = { id: userId, key: created.user_key };
    const rootUri = 'viking://user/' + user.id + '/memories/test-probe-' + runId, uri = rootUri + '/probe.md';
    const absent = await ov('/api/v1/fs/stat?' + new URLSearchParams({ uri: rootUri }), undefined, { key: user.key, allow: [404] });
    check(absent.status === 404, 'ov_probe_path_preexisted');
    await ov('/api/v1/fs/mkdir', { uri: rootUri }, { key: user.key });
    await ov('/api/v1/content/batch-write', { root_uri: rootUri, operations: [{ uri, content, mode: 'create' }],
      wait: false, defer_processing: true }, { key: user.key });
    const { splitStoredMemory } = await import('./memory-perf/openviking.mjs');
    const deadline = Date.now() + 15000; let verified = false;
    while (Date.now() < deadline) {
      const read = await ov('/api/v1/content/read?' + new URLSearchParams({ uri }), undefined, { key: user.key, allow: [404] });
      if (read.status === 200 && sha256(splitStoredMemory(read.data).body ?? '') === sha256(content)) { verified = true; break; }
      await delay(250);
    }
    check(verified, 'ov_probe_readback_failed');
    report.checks.ovBodyHash = true;
    report.ovWriteMode = 'defer_processing; content only, no semantic-index assertion';
  } catch (error) {
    report.failure = { code: /^[a-z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'test_probe_request_failed' };
    throw error;
  } finally {
    const cleanup = async (name, action) => {
      try { await action(); } catch (error) {
        report.cleanup[name] = false;
        (report.cleanupErrors ??= []).push({ resource: name, code: /^[a-z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'cleanup_request_failed' });
      }
    };
    if (coreRow) {
      await cleanup('core', async () => {
      const rows = (await core('query', { session_id: 'test-session-' + runId, limit: 2 })).data;
      check(rows.messages?.length === 1 && rows.messages[0].id === coreRow && rows.messages[0].content === content, 'refuse_unknown_core_cleanup');
      const removed = (await core('delete', { message_ids: [coreRow] })).data;
      report.cleanup.core = removed.deleted_count === 1 && (await core('query', { session_id: 'test-session-' + runId, limit: 2 })).data.messages.length === 0;
      });
    }
    if (wikiId) {
      await cleanup('wiki', async () => {
      const detail = (await wiki('get', { wiki_id: wikiId })).data;
      check(detail.name === 'test-probe-' + runId && detail.team_id === b.team && detail.owner_user_id === b.writer.userId, 'refuse_unknown_wiki_cleanup');
      report.cleanup.wiki = (await wiki('delete', { wiki_ids: [wikiId] })).data.deleted_ids?.includes(wikiId) === true;
      });
    }
    if (user) {
      await cleanup('openviking', async () => {
      const removed = (await ov('/api/v1/admin/accounts/' + b.ov.accountId + '/users/' + user.id, undefined, { method: 'DELETE' })).data;
      if (removed.task_id) report.cleanupTasks = { openviking: { taskId: removed.task_id, accountId: b.ov.accountId, userId: user.id } };
      check(removed.task_id && removed.account_id === b.ov.accountId && removed.user_id === user.id, 'ov_probe_cleanup_task_missing');
      const deadline = Date.now() + 360000;
      while (Date.now() < deadline) {
        const task = (await ov('/api/v1/tasks/' + removed.task_id)).data;
        check(!['failed', 'cancelled'].includes(task.status), 'ov_probe_cleanup_failed');
        if (task.status === 'completed') {
          const absent = await ov('/api/v1/admin/accounts/' + b.ov.accountId + '/users/' + user.id, undefined, { allow: [404] });
          report.cleanup.openviking = absent.status === 404; break;
        }
        await delay(500);
      }
      check(report.cleanup.openviking, 'ov_probe_cleanup_deadline');
      });
    }
    report.accepted = !report.failure && Object.keys(report.checks).length === 6 && Object.values(report.checks).every(Boolean) &&
      ['core', 'wiki', 'openviking'].every(key => report.cleanup[key] === true);
    report.finishedAt = new Date().toISOString(); save(file, report);
  }
  check(report.accepted, 'test_scope_probe_failed'); return file;
}

async function stop(state) {
  const snapshot = processSnapshot(Object.values(state.processes).flatMap(row => [row.pid, row.launcher?.pid].filter(Boolean)));
  // A failed startup can own a process without a listener. Validate all live
  // identities before stopping any of them; unknown listeners still fail closed.
  for (const listener of snapshot.listeners) {
    const kind = Object.keys(ports).find(key => ports[key] === listener.port), record = state.processes[kind];
    check(record && listener.pid === record.pid && listener.address === '127.0.0.1', 'refuse_unknown_test_listener');
  }
  for (const record of Object.values(state.processes)) {
    for (const identity of [record, record.launcher].filter(Boolean)) {
      const actual = snapshot.processes.find(row => row.pid === identity.pid);
      check(!actual || processIdentityMatches(actual, identity), 'refuse_reused_process_id');
    }
  }
  for (const kind of ['openviking', 'knowledge', 'core']) {
    const record = state.processes[kind];
    if (!record) continue;
    for (const identity of [record, record.launcher].filter(Boolean)) {
      const current = processSnapshot([identity.pid]).processes.find(row => row.pid === identity.pid);
      if (!current) continue;
      check(processIdentityMatches(current, identity), 'refuse_reused_process_id');
      const code = `
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$env:TSP_ENGINE_STOP_PID)
if($p) {
 if($p.CreationDate.ToUniversalTime().ToString('o') -ne $env:TSP_ENGINE_STOP_CREATED) { throw 'PID identity changed' }
 Stop-Process -Id $p.ProcessId -ErrorAction Stop
}
`;
      run(powershell, ['-NoProfile', '-NonInteractive', '-Command', code], { ...isolatedEnvironment(runtimeRoot),
        TSP_ENGINE_STOP_PID: String(identity.pid), TSP_ENGINE_STOP_CREATED: identity.createdAt });
    }
  }
  for (let i = 0; i < 20 && processSnapshot().listeners.length; i++) await delay(250);
  check(processSnapshot().listeners.length === 0, 'test_listener_still_running');
  state.processes = {}; state.stoppedAt = new Date().toISOString(); save(manifestFile, state);
  return { stopped: true, previousListeners: snapshot.listeners.length, dataPreserved: true };
}

export async function provisionTestMemoryEngines(action = 'start') {
  check(process.platform === 'win32', 'windows_required');
  if (action === 'recover-empty-bootstrap') {
    check(existsSync(runtimeRoot) && !existsSync(manifestFile) && !existsSync(pendingFile), 'empty_recovery_not_applicable');
    check(processSnapshot().listeners.length === 0, 'test_port_in_use');
    assertEmptyBootstrapTree();
    save(pendingFile, { purpose: 'team-synergy-test-memory-engines-bootstrap', runtimeRoot,
      nonce: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), recoveredEmptyDirectory: true });
    return { recovered: true, runtimeRoot, deletedFiles: 0 };
  }
  if (action === 'start') await initialize();
  const { state, deployment, conf } = load();
  if (action === 'stop') return stop(state);
  if (action === 'start') { await start(state); await bootstrap(state, deployment, conf); }
  check(['start', 'status', 'verify', 'probe'].includes(action), 'unknown_action');
  verifyProcesses(state, { allowStopped: action === 'status' });
  const probeReport = action === 'probe' ? await probe(state, deployment, conf) : undefined;
  const serviceHealth = Object.fromEntries(await Promise.all(Object.keys(ports).map(async kind => [kind, await health(kind)])));
  if (action !== 'status') check(Object.values(serviceHealth).every(Boolean), 'service_health_not_ready');
  return { runtimeRoot, enginesFile: existsSync(privateFile) ? privateFile : null, ports,
    pids: Object.fromEntries(Object.entries(state.processes).map(([kind, row]) => [kind, row.pid])),
    health: serviceHealth,
    ...(probeReport ? { probeReport } : {}), isolated: true, credentials: 'private files only; no business deployment read' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const action = process.argv[2] ?? 'start';
    if (['serve-core', 'serve-knowledge'].includes(action)) {
      load(); // Fail closed before importing an external launcher.
      process.env.HUB_TENCENT_RUNTIME_DIR = path.join(runtimeRoot, 'tencent');
      process.argv = [process.execPath, tencentLauncher, action];
      await import(pathToFileURL(tencentLauncher));
    } else console.log(JSON.stringify(await provisionTestMemoryEngines(action)));
  } catch (error) {
    console.error(JSON.stringify({ accepted: false, code: /^[a-z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'test_engine_operation_failed',
      message: 'Inspect the dedicated test runtime private logs; no business service was stopped or reconfigured.' }));
    process.exitCode = 1;
  }
}

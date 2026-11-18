import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deploymentGate } from '../../deploy/containers/workflow-gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = 'a'.repeat(40), other = 'b'.repeat(40), repository = 'owner/team-synergy';
const run = { conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha, head_repository: { full_name: repository } };
const request = changes => ({ eventName: 'workflow_run', event: { workflow_run: run }, repository, ref: 'refs/heads/main', sha, ...changes });
const verifiedApi = async route => route.includes('/git/ref/') ? { object: { sha } } : { workflow_runs: [run] };

test('container and deployment stop deadlines allow the API bounded drain to finish', () => {
  const compose = readFileSync(path.join(root, 'deploy/containers/compose.yaml'), 'utf8');
  const script = readFileSync(path.join(root, 'scripts/deploy-linux.sh'), 'utf8');
  assert.match(compose, /\n  api:[\s\S]*?stop_grace_period: 90s/);
  assert.match(script, /compose stop --timeout 90 api web/);
});

test('PR builds never request privileged workflow verification or publication', async () => {
  const result = await deploymentGate(request({ eventName: 'pull_request', api: () => { throw Error('Unexpected privileged lookup'); } }));
  assert.deepEqual(result, { build: true, publish: false, sha });
});

for (const [name, changes] of [
  ['failed CI', { conclusion: 'failure' }], ['PR CI', { event: 'pull_request' }],
  ['other branch', { head_branch: 'feature/test' }], ['fork repository', { head_repository: { full_name: 'attacker/team-synergy' } }],
]) test(`${name} cannot trigger a trusted deployment`, async () => {
  assert.deepEqual(await deploymentGate(request({ event: { workflow_run: { ...run, ...changes } }, api: () => { throw Error('Should not query'); } })), { build: false, publish: false });
});

test('old successful CI cannot overwrite a newer main', async () => {
  assert.deepEqual(await deploymentGate(request({ api: async () => ({ object: { sha: other } }) })), { build: false, publish: false });
});

test('manual dispatch needs main and an exact successful push CI', async () => {
  assert.deepEqual(await deploymentGate(request({ eventName: 'workflow_dispatch', ref: 'refs/heads/feature/test', api: verifiedApi })), { build: false, publish: false });
  assert.deepEqual(await deploymentGate(request({ eventName: 'workflow_dispatch', api: async route => route.includes('/git/ref/') ? { object: { sha } } : { workflow_runs: [{ ...run, head_sha: other }] } })), { build: false, publish: false, sha });
  assert.deepEqual(await deploymentGate(request({ eventName: 'workflow_dispatch', api: verifiedApi })), { build: true, publish: true, sha });
});

test('current successful main CI produces only its verified immutable source', async () => {
  assert.deepEqual(await deploymentGate(request({ api: verifiedApi })), { build: true, publish: true, sha });
  await assert.rejects(deploymentGate(request({ event: { workflow_run: { ...run, head_sha: 'main;echo unsafe' } }, api: verifiedApi })), /Invalid source/);
  await assert.rejects(deploymentGate(request({ api: async () => { throw Error('API unavailable'); } })), /API unavailable/);
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsp-deploy-test-'));
  for (const name of ['config', 'config/runtime', 'deploy', 'backups', 'releases', 'cli-distribution']) mkdirSync(path.join(directory, name), { mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path.join(directory, 'config/server.env'), `TSP_IMAGE_PREFIX=ghcr.io/${repository}\nTSP_CONFIG_DIR=${directory}/config\nTSP_CLI_DIST_DIR=${directory}/cli-distribution\n`);
  writeFileSync(path.join(directory, 'config/api.env'), '');
  writeFileSync(path.join(directory, 'config/db-password'), 'isolated-test-password', { mode: 0o600 });
  writeFileSync(path.join(directory, 'config/db-admin-password'), 'isolated-admin-password', { mode: 0o600 });
  writeFileSync(path.join(directory, 'deploy/compose.yaml'), 'services: {}\n');
  writeFileSync(path.join(directory, 'deploy/init-db.sh'), '#!/bin/sh\n');
  return directory;
}
const refs = ['api', 'web', 'postgres'].map((role, index) => `ghcr.io/${repository}-${role}@sha256:${String(index + 1).repeat(64)}`);
function invoke(directory, args, env = {}) {
  return spawnSync('/bin/bash', [path.join(root, 'scripts/deploy-linux.sh'), ...args], { env: { ...process.env, TSP_DEPLOY_ROOT: directory, ...env }, encoding: 'utf8' });
}

test('Linux validation accepts pinned roles without invoking Docker or changing services', { skip: process.platform !== 'linux' }, () => {
  const directory = fixture();
  try {
    const r = invoke(directory, ['--validate', sha, ...refs]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /no services changed/);
    assert.deepEqual(readFileSync(path.join(directory, 'config/db-password'), 'utf8'), 'isolated-test-password');
    assert.equal(existsSync(path.join(directory, 'release.env')), false);
    const loaded = invoke(directory, ['--validate-loaded', sha, ...refs.map((_, i) => `sha256:${String(i + 1).repeat(64)}`)]);
    assert.equal(loaded.status, 0, loaded.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Linux validation rejects mutable tags, wrong namespaces, malformed digests and shell fragments', { skip: process.platform !== 'linux' }, () => {
  const directory = fixture();
  try {
    for (const bad of ['ghcr.io/owner/team-synergy-api:latest', `ghcr.io/attacker/team-synergy-api@sha256:${'1'.repeat(64)}`, `${refs[0]}@sha256:${'1'.repeat(64)}`, `${refs[0]};touch /tmp/unsafe`]) {
      assert.equal(invoke(directory, ['--validate', sha, bad, refs[1], refs[2]]).status, 2);
    }
    assert.equal(invoke(directory, ['--validate', '../main', ...refs]).status, 2);
    assert.equal(invoke(directory, ['--validate-loaded', sha, ...refs]).status, 2);
    assert.equal(invoke(directory, [], { SSH_ORIGINAL_COMMAND: `deploy ${sha} ${refs.join(' ')}\nwhoami` }).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Linux validation rejects symlink boundaries and public-writable deployment roots', { skip: process.platform !== 'linux' }, () => {
  const directory = fixture();
  try {
    chmodSync(directory, 0o777);
    assert.equal(invoke(directory, ['--validate', sha, ...refs]).status, 2);
    chmodSync(directory, 0o700);
    symlinkSync(path.join(directory, 'config/server.env'), path.join(directory, 'release.env'));
    assert.equal(invoke(directory, ['--validate', sha, ...refs]).status, 2);
    assert.equal(invoke('/', ['--validate', sha, ...refs]).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Linux offline deployment keeps backups and reports migration failure without resetting database', { skip: process.platform !== 'linux' }, () => {
  const directory = fixture(), bin = path.join(directory, 'bin'), trace = path.join(directory, 'trace');
  mkdirSync(bin);
  const ids = refs.map((_, i) => `sha256:${String(i + 1).repeat(64)}`);
  writeFileSync(path.join(directory, 'release.env'), 'TSP_API_IMAGE=old-api\nTSP_WEB_IMAGE=old-web\n');
  writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$TRACE"\nif [[ $1 == image ]]; then if [[ $* == *'{{.Id}}'* ]];then echo "${'$'}{!#}";else echo "$REVISION";fi;exit 0;fi\nif [[ $1 == run ]];then echo 'postgres (PostgreSQL) 16.11';exit 0;fi\nif [[ $* == *'exec -T db'* ]];then printf 'PGDMPtest';exit 0;fi\nif [[ $* == *'run --rm --no-deps migrate'* ]];then exit 17;fi\nexit 0\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const r = invoke(directory, ['deploy-loaded', sha, ...ids], { PATH: bin + ':' + process.env.PATH, TRACE: trace, REVISION: sha });
    assert.equal(r.status, 17, r.stderr);
    const calls = readFileSync(trace, 'utf8');
    assert.doesNotMatch(calls, /^pull |down|volume rm/m);
    assert.ok(calls.indexOf('exec -T db') < calls.indexOf('run --rm --no-deps migrate'));
    assert.match(calls, /previous-.*up -d --no-deps api web/);
    assert.match(readFileSync(path.join(directory, 'release.env'), 'utf8'), /old-api/);
    assert.match(r.stderr, /database was not restored/);
    assert.equal(readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('.dump')).length, 1);
    const failure = readdirSync(path.join(directory, 'releases')).find(name => name.startsWith('failure-'));
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'releases', failure), 'utf8')).database_restored, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const state of ['exited false 1 false', 'exited false 137 false', 'exited false 0 true', 'running true 0 false']) {
  test(`Linux deployment refuses backup and migration after unsuccessful drain: ${state}`, { skip: process.platform !== 'linux' }, () => {
    const directory = fixture(), bin = path.join(directory, 'bin'), trace = path.join(directory, 'trace');
    mkdirSync(bin);
    const ids = refs.map((_, i) => `sha256:${String(i + 1).repeat(64)}`);
    writeFileSync(path.join(directory, 'release.env'), 'TSP_API_IMAGE=old-api\nTSP_WEB_IMAGE=old-web\n');
    writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
if [[ $1 == image ]];then if [[ $* == *'{{.Id}}'* ]];then echo "${'$'}{!#}";else echo "$REVISION";fi;exit 0;fi
if [[ $1 == run ]];then echo 'postgres (PostgreSQL) 16.11';exit 0;fi
if [[ $* == *'ps --all --quiet api'* ]];then echo aaaaaaaaaaaa;exit 0;fi
if [[ $1 == inspect ]];then echo "$API_STATE";exit 0;fi
exit 0
`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const result = invoke(directory, ['deploy-loaded', sha, ...ids], {
        PATH: bin + ':' + process.env.PATH, TRACE: trace, REVISION: sha, API_STATE: state,
      });
      assert.equal(result.status, 7, result.stderr);
      const calls = readFileSync(trace, 'utf8');
      assert.match(calls, /stop --timeout 90 api web/);
      assert.match(calls, /inspect .* aaaaaaaaaaaa/);
      assert.doesNotMatch(calls, /exec -T db|run --rm --no-deps migrate/);
      assert.equal(readdirSync(path.join(directory, 'backups')).length, 0);
      assert.match(result.stderr, /refusing backup and migration/);
      const failure = readdirSync(path.join(directory, 'releases')).find(name => name.startsWith('failure-'));
      assert.equal(JSON.parse(readFileSync(path.join(directory, 'releases', failure), 'utf8')).stage, 'drain-check');
      assert.match(calls, /previous-.*up -d --no-deps api web/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('Linux deployment accepts a cleanly stopped API before its backup stage', { skip: process.platform !== 'linux' }, () => {
  const directory = fixture(), bin = path.join(directory, 'bin'), trace = path.join(directory, 'trace');
  mkdirSync(bin);
  const ids = refs.map((_, i) => `sha256:${String(i + 1).repeat(64)}`);
  writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
if [[ $1 == image ]];then if [[ $* == *'{{.Id}}'* ]];then echo "${'$'}{!#}";else echo "$REVISION";fi;exit 0;fi
if [[ $1 == run ]];then echo 'postgres (PostgreSQL) 16.11';exit 0;fi
if [[ $* == *'ps --all --quiet api'* ]];then echo aaaaaaaaaaaa;exit 0;fi
if [[ $1 == inspect ]];then echo 'exited false 0 false';exit 0;fi
if [[ $* == *'exec -T db'* ]];then printf 'PGDMPtest';exit 0;fi
if [[ $* == *'run --rm --no-deps migrate'* ]];then exit 17;fi
exit 0
`, { mode: 0o755 });
  try {
    const result = invoke(directory, ['deploy-loaded', sha, ...ids], { PATH: bin + ':' + process.env.PATH, TRACE: trace, REVISION: sha });
    assert.equal(result.status, 17, result.stderr);
    const calls = readFileSync(trace, 'utf8');
    assert.ok(calls.indexOf('inspect --format') < calls.indexOf('exec -T db'));
    assert.equal(readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('.dump')).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertOwnedPath, isolatedEnvironment, validateManifest, processIdentityMatches, descendantOf, runtimeRoot, ports } from '../scripts/provision-test-memory-engines.mjs';

test('module import is inert and fixed test ports cannot be overridden', () => {
  assert.deepEqual(ports, { core: 18520, knowledge: 18524, openviking: 21933 });
  assert.throws(() => { ports.core = 8420; }, TypeError);
});

test('owned path guard rejects traversal and other runtime roots', () => {
  assert.equal(assertOwnedPath(runtimeRoot, path.join(runtimeRoot, 'openviking/data')), path.join(runtimeRoot, 'openviking/data'));
  for (const target of [path.join(runtimeRoot, '../recovery'), 'C:/Users/Liam', 'F:/workspace/team-knowledge-runtime/openviking/data'])
    assert.throws(() => assertOwnedPath(runtimeRoot, target), { code: 'path_outside_test_runtime' });
});

test('service environment excludes every database, model, auth and config override', () => {
  const env = isolatedEnvironment(runtimeRoot, { PATH: 'safe-path', DATABASE_URL: 'business', TSP_TEST_DATABASE_URL: 'business',
    OPENVIKING_CONFIG_FILE: 'business', TDAI_DATA_DIR: 'business', TDAI_GATEWAY_API_KEY: 'secret',
    NODE_OPTIONS: '--require unsafe', HOME: 'business-home', LLM_API_KEY: 'secret', KNOWLEDGE_DB_PATH: 'business' });
  assert.equal(env.PATH, 'safe-path');
  assert.equal(env.HOME, path.join(runtimeRoot, 'home'));
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.equal(env.no_proxy, env.NO_PROXY);
  for (const key of ['DATABASE_URL', 'TSP_TEST_DATABASE_URL', 'OPENVIKING_CONFIG_FILE', 'TDAI_DATA_DIR', 'TDAI_GATEWAY_API_KEY',
    'NODE_OPTIONS', 'LLM_API_KEY', 'KNOWLEDGE_DB_PATH']) assert.equal(env[key], undefined);
});

test('only a marked fixed source/program deployment may be reused', () => {
  const manifest = { version: 1, purpose: 'team-synergy-test-memory-engines', runtimeRoot, nonce: 'a'.repeat(64), ports,
    tencentSource: 'F:/workspace/team-knowledge-runtime/tencent/source',
    tencentLauncher: 'F:/workspace/team-knowledge-hub/scripts/deploy-tencent.mjs',
    openvikingExecutable: 'F:/workspace/team-knowledge-runtime/openviking/.venv/Scripts/openviking-server.exe' };
  assert.equal(validateManifest(manifest), manifest);
  for (const change of [{ version: 2 }, { runtimeRoot: 'F:/workspace/team-knowledge-runtime' }, { nonce: '' },
    { ports: { ...ports, core: 8420 } }, { tencentSource: 'F:/elsewhere' }, { openvikingExecutable: 'C:/malicious.exe' }])
    assert.throws(() => validateManifest({ ...manifest, ...change }));
});

test('stop ownership requires PID, birth time, executable and command hash together', () => {
  const actual = { pid: 45678, createdAt: '2026-11-12T00:00:00.000Z', executable: 'C:/node/node.exe', commandLine: 'node owned.mjs serve-core' };
  const recorded = { ...actual, commandHash: createHash('sha256').update(actual.commandLine).digest('hex') };
  assert.equal(processIdentityMatches(actual, recorded), true);
  for (const changed of [{ pid: 1 }, { createdAt: '2026-11-12T00:00:01.000Z' }, { executable: 'C:/malicious.exe' },
    { commandLine: 'node business.mjs' }]) assert.equal(processIdentityMatches({ ...actual, ...changed }, recorded), false);
});

test('Windows Python launcher descendants must have a complete parent chain', () => {
  assert.equal(descendantOf([{ pid: 3, parentPid: 2 }, { pid: 2, parentPid: 1 }], 3, 1), true);
  assert.equal(descendantOf([], 1, 1), true);
  assert.equal(descendantOf([{ pid: 3, parentPid: 4 }, { pid: 4, parentPid: 3 }], 3, 1), false);
  assert.equal(descendantOf([{ pid: 3, parentPid: 2 }], 3, 1), false);
});

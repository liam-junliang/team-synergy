import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installedSessionConfig } from '../dist/memory-harness-install.js';
import { nativeCaptureEventId } from '../dist/memory-native-capture.js';

import {harnessFixture} from './memory-harness-fixture.mjs';

function nativeTranscript(f, session, changes = {}) {
  const file = path.join(f.home, 'sessions', session + '.jsonl');
  const meta = { id: session, cwd: f.cwd, source: 'exec', cli_version: '0.145.0', ...changes };
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: meta }) + '\n');
  return { file, append(turn, body) {
    for (const row of [{ type: 'turn_context', payload: { turn_id: turn } },
      { type: 'event_msg', payload: { type: 'user_message', message: body, images: [], local_images: [], audio: [], local_audio: [], text_elements: [] } }]) {
      appendFileSync(file, JSON.stringify(row) + '\n');
    }
  } };
}
const event = (f, transcript, session, name, extra = {}) => ({ hook_event_name: name, cwd: f.cwd, transcript_path: transcript.file,
  session_id: session, ...(name === 'SessionStart' ? { source: 'startup' } : {}), ...extra });
function localRows(installation, session) {
  const config = installedSessionConfig(installation, session);
  const hash = createHash('sha256').update(JSON.stringify([config.owner, config.harness, config.hostSessionId, config.memorySession])).digest('hex');
  const file = path.join(config.memberHome, 'memory-native-outbox', hash + '.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT event_id,source_text,state FROM events').all(); } finally { db.close(); }
}
async function waitForPosts(f, count) {
  const deadline = Date.now() + 6000;
  while (f.posts.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.posts.length, count);
  await new Promise(resolve => setTimeout(resolve, 150));
}

test('persistent install preserves foreign hooks and config, requires host trust and removes only its own entries', async t => {
  const f = await harnessFixture(t), hooks = path.join(f.home, 'hooks.json');
  const foreign = { hooks: [{ type: 'command', command: 'omx existing-hook' }] };
  writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [foreign] }, description: 'keep me' }));
  writeFileSync(path.join(f.home, 'config.toml'), 'existing = "unchanged"\n');
  writeFileSync(path.join(f.home, 'hook-trust.json'), 'TRUST-SENTINEL');
  const installed = await f.install(); assert.equal(installed.code, 0, installed.error);
  const info = installed.value.data;
  assert.equal(info.collectionObserved, false); assert.match(info.hookTrust, /review/);
  assert.equal(readFileSync(path.join(f.home, 'config.toml'), 'utf8'), 'existing = "unchanged"\n');
  assert.equal(readFileSync(path.join(f.home, 'hook-trust.json'), 'utf8'), 'TRUST-SENTINEL');
  assert.equal(JSON.parse(readFileSync(info.backupFile, 'utf8')).description, 'keep me');
  const current = JSON.parse(readFileSync(hooks, 'utf8')); assert.deepEqual(current.hooks.Stop[0], foreign);
  current.hooks.Stop.push({ hooks: [{ type: 'command', command: 'later user hook' }] }); writeFileSync(hooks, JSON.stringify(current));
  const diagnosis = await f.run(['doctor', '--harness', 'codex']);
  assert.equal(diagnosis.value.data.status, 'awaiting_new_session'); assert.match(diagnosis.value.data.hookTrust, /unknown/);
  assert.equal((await f.install()).value.error.code, 'memory_harness_already_installed');
  assert.equal((await f.run(['uninstall', '--harness', 'codex'])).code, 0);
  const removed = JSON.parse(readFileSync(hooks, 'utf8')); assert.equal(removed.hooks.Stop.length, 2); assert.deepEqual(removed.hooks.Stop[0], foreign);
  assert.equal((await f.run(['doctor', '--harness', 'codex'])).value.data.status, 'memory_harness_not_installed');
});

test('missing identity, unbound projects, unknown versions and revoked credentials never install or mutate host settings', async t => {
  const f = await harnessFixture(t), config = path.join(f.home, 'hooks.json');
  writeFileSync(f.runtime, "console.log('codex-cli 0.146.0');\n");
  assert.equal((await f.install()).value.error.code, 'memory_harness_version_unsupported'); assert.equal(existsSync(config), false);
  writeFileSync(f.runtime, "console.log('codex-cli 0.145.0');\n"); f.setAuthorized(false);
  assert.equal((await f.install()).value.error.code, 'login_required'); assert.equal(existsSync(config), false); f.setAuthorized(true);
  const authFile = path.join(f.member, 'auth.json'); writeFileSync(authFile, '{}');
  assert.equal((await f.install()).value.error.code, 'login_required'); assert.equal(existsSync(config), false);
  writeFileSync(authFile, JSON.stringify(f.auth)); rmSync(path.join(f.cwd, '.agent', 'bound-project.yaml'));
  assert.equal((await f.install()).value.error.code, 'project_binding_required'); assert.equal(existsSync(config), false);
});

test('persistent install fails closed on disabled, denied or malformed capture preflight', async t => {
  const f = await harnessFixture(t), config = path.join(f.home, 'hooks.json');
  for (const preflight of [{ serviceEnabled: false, allowed: false, reason: 'memory_capture_disabled' },
    { serviceEnabled: true, allowed: false, reason: 'memory_forbidden' }]) {
    f.setPreflight(preflight);
    assert.equal((await f.install()).value.error.code, preflight.reason);
    const { data } = (await f.run(['doctor', '--harness', 'codex'])).value;
    assert.equal(data.status, preflight.reason);
    assert.deepEqual(data.capturePreflight, preflight);
    assert.equal(existsSync(config), false);
  }
  f.setPreflight({ serviceEnabled: false, allowed: true, reason: null });
  assert.equal((await f.install()).value.error.code, 'api_bad_response');
  assert.equal(existsSync(config), false);
  assert.equal(f.posts.length, 0);
});

test('doctor distinguishes delivery failure from server receipt and clears it after retry', async t => {
  const f = await harnessFixture(t), installed = (await f.install()).value.data;
  const registration = JSON.parse(readFileSync(installed.installationFile, 'utf8'));
  const scope = installedSessionConfig(registration, 'delivery-session');
  const args = ['--harness', scope.harness, '--host-session', scope.hostSessionId, '--session', scope.memorySession, '--owner', scope.owner];
  const eventId = nativeCaptureEventId('codex', scope.hostSessionId, 'operator-turn');
  assert.equal((await f.run(['enqueue', ...args], { ready: true,
    event: { eventId, nativeMessageId: 'operator-turn', sourceText: 'PRIVATE-OPERATOR-SOURCE' } })).code, 0);
  f.setDeliveryFailure(true);
  assert.equal((await f.run(['drain', ...args])).value.data.errorCode, 'fixture_delivery_unavailable');
  const failed = (await f.run(['doctor', '--harness', 'codex'])).value.data;
  assert.equal(failed.remoteDelivery, 'local_delivery_failed');
  assert.equal(failed.deliveryErrorCode, 'fixture_delivery_unavailable');
  assert.equal(failed.latestCapture, null);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-/);
  f.setDeliveryFailure(false);
  assert.equal((await f.run(['drain', ...args])).value.data.accepted, 1);
  assert.equal(f.posts.length, 1);
  const recovered = (await f.run(['doctor', '--harness', 'codex'])).value.data;
  assert.equal(recovered.remoteDelivery, 'verified_server_receipt');
  assert.equal(recovered.deliveryErrorCode, null);
  assert.equal(recovered.latestCapture.status, 'pending');
});

test('Codex digests stage without body, verified native turns span new sessions and replay exactly once', async t => {
  const f = await harnessFixture(t), installed = (await f.install()).value.data;
  const registration = JSON.parse(readFileSync(installed.installationFile, 'utf8'));
  for (const session of ['first-session', 'second-session']) {
    const transcript = nativeTranscript(f, session);
    transcript.append('old-turn', 'HISTORICAL-BODY-DO-NOT-IMPORT');
    const invoke = input => f.run(['event', '--installation', installed.installationFile], input);
    assert.deepEqual((await invoke(event(f, transcript, session, 'SessionStart'))).value, {});
    const body = 'Verified operator input ' + session;
    const prompt = event(f, transcript, session, 'UserPromptSubmit', { turn_id: 'current-turn', prompt: body });
    await invoke(prompt); await invoke(prompt); assert.deepEqual(localRows(registration, session), []);
    transcript.append('current-turn', body);
    const stop = event(f, transcript, session, 'Stop', { turn_id: 'current-turn', stop_hook_active: false });
    assert.deepEqual((await invoke(stop)).value, {}); await invoke(stop);
    const rows = localRows(registration, session); assert.equal(rows.length, 1); assert.equal(rows[0].source_text, body);
  }
  await waitForPosts(f, 2);
  assert.notEqual(f.posts[0].sessionId, f.posts[1].sessionId);
  assert.ok(f.posts.every(row => !row.sourceText.includes('HISTORICAL')));
  assert.doesNotMatch(readFileSync(registration.auditFile, 'utf8'), /Verified operator input|HISTORICAL-BODY/);
  f.setCaptureStatus('skipped');
  const { data } = (await f.run(['doctor', '--harness', 'codex'])).value;
  assert.equal(data.remoteDelivery, 'verified_server_receipt');
  assert.equal(data.latestCapture.captureCode, '2'.padStart(20, '0'));
  assert.equal(data.latestCapture.status, 'skipped');
  assert.equal(data.latestCapture.statusSource, 'server');
  assert.equal(data.latestCapture.errorCode, 'memory_no_material');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE-SERVER|Verified operator input/);
  f.setCaptureStatus(null);
  const offline = (await f.run(['doctor', '--harness', 'codex'])).value.data;
  assert.equal(offline.remoteDelivery, 'acknowledged_status_unavailable');
  assert.equal(offline.latestCapture.statusSource, 'delivery_receipt');
  assert.equal(offline.latestCapture.refreshErrorCode, 'memory_capture_not_found');
});

test('Codex rejects subagents, unverified Desktop versions, mirrors, automatic continuations and account changes', async t => {
  const f = await harnessFixture(t), installed = (await f.install()).value.data;
  const registration = JSON.parse(readFileSync(installed.installationFile, 'utf8'));
  const invoke = input => f.run(['event', '--installation', installed.installationFile], input);
  for (const [session, metadata] of [['child', { source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } } }],
    ['desktop', { source: 'vscode', cli_version: '0.170.0-alpha.1' }]]) {
    const transcript = nativeTranscript(f, session, metadata);
    const denied = await invoke(event(f, transcript, session, 'SessionStart'));
    assert.match(denied.value.systemMessage, /memory_codex_(source_not_operator|version_unsupported)/);
    assert.deepEqual(localRows(registration, session), []);
  }
  const transcript = nativeTranscript(f, 'root'); await invoke(event(f, transcript, 'root', 'SessionStart'));
  await invoke(event(f, transcript, 'root', 'UserPromptSubmit', { turn_id: 'mirror', prompt: 'retrieval mirror' }));
  appendFileSync(transcript.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'retrieval mirror' }] } }) + '\n');
  assert.match((await invoke(event(f, transcript, 'root', 'Stop', { turn_id: 'mirror', stop_hook_active: false }))).value.systemMessage, /unconfirmed/);
  await invoke(event(f, transcript, 'root', 'UserPromptSubmit', { turn_id: 'auto', prompt: 'automatic continuation' }));
  transcript.append('auto', 'automatic continuation'); await invoke(event(f, transcript, 'root', 'Stop', { turn_id: 'auto', stop_hook_active: true }));
  assert.deepEqual(localRows(registration, 'root'), []);
  writeFileSync(path.join(f.member, 'auth.json'), JSON.stringify({ ...f.auth, user_code: 'another', device_token: 'other-device' }));
  assert.match((await invoke(event(f, transcript, 'root', 'SessionStart'))).value.systemMessage, /memory_binding_changed/);
  assert.equal(f.posts.length, 0);
});

test('verified Desktop alpha typed operator events require root turn attribution and ignore raw user mirrors', async t => {
  const f = await harnessFixture(t);
  const version = '0.171.0-alpha.13';
  writeFileSync(f.runtime, `console.log('codex-cli ${version}');\n`);
  const installed = (await f.install()).value.data, registration = JSON.parse(readFileSync(installed.installationFile, 'utf8'));
  const invoke = input => f.run(['event', '--installation', installed.installationFile], input);
  for (const [session, override] of [['desktop', {}], ['delegated', { initiating_agent_path: ['root', 'child'] }],
    ['continuation', { parent_turn_id: 'earlier-turn', turn_trigger: 'stop_hook' }]]) {
    const transcript = nativeTranscript(f, session, { source: 'vscode', cli_version: version });
    const turn = 'native-turn', body = 'Native operator ' + session;
    // Verified real host order: task metadata exists before SessionStart, but
    // the typed user event appears only after UserPromptSubmit returns.
    appendFileSync(transcript.file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn, turn_attribution: {
      turn_id: turn, root_turn_id: turn, parent_turn_id: null, initiating_agent_path: null, turn_trigger: null, ...override } } }) + '\n');
    await invoke(event(f, transcript, session, 'SessionStart'));
    const prompted = await invoke(event(f, transcript, session, 'UserPromptSubmit', { turn_id: turn, prompt: body }));
    const rows = [
      { type: 'turn_context', payload: { turn_id: turn } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type: 'UserMessage',
        content: [{ type: 'text', text: body, text_elements: [] }] } } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'AUTOMATIC-MIRROR' }] } },
    ];
    for (const row of rows) appendFileSync(transcript.file, JSON.stringify(row) + '\n');
    const result = await invoke(event(f, transcript, session, 'Stop', { turn_id: turn, stop_hook_active: false }));
    if (session === 'desktop') { assert.deepEqual(result.value, {}); assert.equal(localRows(registration, session)[0].source_text, body); }
    else { assert.match(prompted.value.systemMessage, /source_not_operator/); assert.deepEqual(localRows(registration, session), []); }
  }
  await waitForPosts(f, 1);
});

test('DSH patch arrays and OpenCode native plugin lists preserve foreign entries through install and uninstall', async t => {
  for (const [harness, version] of [['dsh', '0.2.1-rc.2'], ['dsh', '0.2.2-rc.5'], ['opencode', '1.14.21']]) {
    const f = await harnessFixture(t);
    writeFileSync(f.runtime, `console.log('${version}');\n`);
    const configFile = path.join(f.home, harness === 'dsh' ? 'cordis.patch.yml' : 'opencode.json');
    const foreign = harness === 'dsh' ? [{ insert: [{ id: 'existing-mcp', name: 'keep-me' }] }] : { plugin: ['file:///existing.mjs'], model: 'keep-me' };
    writeFileSync(configFile, JSON.stringify(foreign));
    const installed = await f.install(harness); assert.equal(installed.code, 0, installed.error);
    const updated = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(harness === 'dsh' ? updated.length : updated.plugin.length, 2);
    assert.equal((await f.run(['uninstall', '--harness', harness])).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), foreign);
  }
});

test('Codex compaction checkpoints skip old mirrored context and resume does not duplicate accepted events', async t => {
  const f = await harnessFixture(t), installed = (await f.install()).value.data;
  const registration = JSON.parse(readFileSync(installed.installationFile, 'utf8'));
  const transcript = nativeTranscript(f, 'compact-session'), invoke = input => f.run(['event', '--installation', installed.installationFile], input);
  await invoke(event(f, transcript, 'compact-session', 'SessionStart'));
  appendFileSync(transcript.file, JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'OLD-MIRROR'.repeat(220000) } }) + '\n');
  await invoke(event(f, transcript, 'compact-session', 'SessionStart', { source: 'compact' }));
  const body = 'New operator text after compaction';
  await invoke(event(f, transcript, 'compact-session', 'UserPromptSubmit', { turn_id: 'new-turn', prompt: body }));
  transcript.append('new-turn', body);
  const stop = event(f, transcript, 'compact-session', 'Stop', { turn_id: 'new-turn', stop_hook_active: false });
  assert.deepEqual((await invoke(stop)).value, {}); await waitForPosts(f, 1);
  await invoke(event(f, transcript, 'compact-session', 'SessionStart', { source: 'resume' })); await invoke(stop);
  assert.equal(localRows(registration, 'compact-session').length, 1);
  assert.equal(localRows(registration, 'compact-session')[0].source_text, body); assert.equal(f.posts.length, 1);
});

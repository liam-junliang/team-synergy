import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { authDirectory } from './auth-store.js';
import { createNativeCaptureBridge, enqueueNativeCapture, nativeCaptureEventId, withNativeCaptureOutbox } from './memory-native-capture.js';
import { harnessRuntimeVersion, installedSessionConfig, readHarnessInstallation, sameHarnessWorkspace, supportedHarnessVersions } from './memory-harness-install.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new DomainError(code, '当前原生来源未获核验，未采集正文；请运行 memory native doctor。'); }
function boundedRead(file: string, offset: number, bytes: number) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes), count = readSync(fd, buffer, 0, bytes, offset);
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
function transcript(event: Record<string, unknown>, hostHome: string, workspace: string) {
  if (typeof event.transcript_path !== 'string' || !path.isAbsolute(event.transcript_path) || lstatSync(event.transcript_path).isSymbolicLink()) fail('memory_codex_source_unavailable');
  const file = realpathSync.native(event.transcript_path), root = realpathSync.native(path.join(hostHome, 'sessions'));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('memory_codex_source_invalid');
  let meta: unknown;
  try { meta = JSON.parse(boundedRead(file, 0, 131072).split('\n')[0] ?? ''); } catch { return fail('memory_codex_source_unsupported'); }
  if (!object(meta) || meta.type !== 'session_meta' || !object(meta.payload)) fail('memory_codex_source_invalid');
  const payload = meta.payload;
  // This is a pinned, experimentally verified transcript fallback, not an official stable schema.
  if (typeof payload.cli_version !== 'string' || !supportedHarnessVersions.codex.includes(payload.cli_version)) fail('memory_codex_version_unsupported');
  const legacyEvents = payload.cli_version === '0.145.0';
  const sources = legacyEvents ? ['exec'] : ['exec', 'vscode'];
  if (typeof payload.source !== 'string' || !sources.includes(payload.source) || payload.id !== event.session_id ||
    !sameHarnessWorkspace(payload.cwd, workspace)) fail('memory_codex_source_not_operator');
  return { file, size: statSync(file).size, legacyEvents, source: payload.source };
}
function rootAttribution(value: unknown, turn: string, source: unknown) {
  return object(value) && value.turn_id === turn && value.root_turn_id === turn && value.parent_turn_id === null &&
    value.initiating_agent_path === null && (source === 'exec' ? value.turn_trigger === 'exec' : source === 'vscode' && value.turn_trigger === null);
}
function promptMetadata(file: string, size: number, turn: string, legacyEvents: boolean, source: string) {
  // Native task_started/turn_context can precede SessionStart. Inspect only a
  // bounded tail for the matching turn's metadata; never import earlier text.
  const offset = Math.max(0, size - 131072), tail = boundedRead(file, offset, size - offset);
  const lines = (offset ? tail.slice(tail.indexOf('\n') + 1) : tail).split('\n').filter(Boolean);
  for (const line of lines) {
    let row: unknown; try { row = JSON.parse(line); } catch { continue; }
    if (!object(row) || !object(row.payload) || row.payload.turn_id !== turn) continue;
    if (legacyEvents && row.type === 'turn_context') return true;
    if (!legacyEvents && row.type === 'event_msg' && row.payload.type === 'task_started') {
      if (!rootAttribution(row.payload.turn_attribution, turn, source)) fail('memory_codex_source_not_operator');
      return true;
    }
  }
  return false;
}
function currentOperator(file: string, offset: number, size: number, turn: string, expectedDigest: string, legacyEvents: boolean, source: string, verifiedMetadata: boolean) {
  if (size < offset || size - offset > 2 * 1024 * 1024) fail('memory_codex_checkpoint_unavailable');
  const input = boundedRead(file, offset, size - offset);
  if (input && !input.endsWith('\n')) fail('memory_codex_source_incomplete');
  let activeTurn: unknown = verifiedMetadata ? turn : undefined, operatorTurn = verifiedMetadata, found: string | undefined;
  for (const line of input.split('\n').filter(Boolean)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { return fail('memory_codex_source_invalid'); }
    if (!object(row) || !object(row.payload)) continue;
    const payload = row.payload;
    if (!legacyEvents && row.type === 'event_msg' && payload.type === 'task_started' && payload.turn_id === turn) {
      operatorTurn = rootAttribution(payload.turn_attribution, turn, source);
      if (!operatorTurn) fail('memory_codex_source_not_operator');
    }
    if (row.type === 'turn_context' || row.type === 'event_msg' && payload.type === 'task_started') activeTurn = payload.turn_id;
    let message: string | undefined;
    if (legacyEvents) {
      if (row.type !== 'event_msg' || payload.type !== 'user_message' || activeTurn !== turn) continue;
      if (typeof payload.message !== 'string' || payload.message.length > 4000 ||
        ['images', 'local_images', 'audio', 'local_audio', 'text_elements'].some(key => payload[key] !== undefined &&
          (!Array.isArray(payload[key]) || (payload[key] as unknown[]).length))) fail('memory_codex_source_unsupported');
      message = payload.message;
    } else {
      if (row.type !== 'event_msg' || payload.type !== 'item_completed' || payload.turn_id !== turn || activeTurn !== turn || !operatorTurn ||
        !object(payload.item) || payload.item.type !== 'UserMessage') continue;
      const item = payload.item;
      if (!Array.isArray(item.content) || !item.content.length || item.content.some(part => !object(part) || part.type !== 'text' ||
        typeof part.text !== 'string' || part.text_elements !== undefined && (!Array.isArray(part.text_elements) || part.text_elements.length))) fail('memory_codex_source_unsupported');
      message = item.content.map(part => (part as { text: string }).text).join('\n');
      if (message.length > 4000) fail('memory_codex_source_unsupported');
    }
    if (digest(message) !== expectedDigest || found !== undefined) fail('memory_codex_source_changed');
    found = message;
  }
  if (found === undefined) fail('memory_codex_source_unconfirmed');
  return found;
}

/** Hooks stage only digests. Text enters the existing durable outbox only after
 * the root-session source, native turn and non-continuation Stop are verified. */
export async function codexLifecycleEvent(installationFile: string, input: unknown) {
  const installation = readHarnessInstallation(installationFile, 'codex');
  const audit = (kind: string, code?: string, eventId?: string) => appendFileSync(installation.auditFile,
    JSON.stringify({ at: new Date().toISOString(), kind, ...(code ? { code } : {}), ...(eventId ? { eventId } : {}) }) + '\n', { mode: 0o600 });
  try {
    if (!object(input) || !['SessionStart', 'UserPromptSubmit', 'Stop'].includes(String(input.hook_event_name)) ||
      typeof input.session_id !== 'string') fail('memory_codex_event_invalid');
    if (!sameHarnessWorkspace(input.cwd, installation.workspace)) return { ignored: 'unregistered_workspace' };
    if (!sameHarnessWorkspace(process.cwd(), installation.workspace)) fail('memory_harness_workspace_mismatch');
    if (!sameHarnessWorkspace(authDirectory(), installation.memberHome)) fail('memory_binding_changed');
    harnessRuntimeVersion('codex', installation.runtime);
    const source = transcript(input, installation.hostHome, installation.workspace);
    const config = installedSessionConfig(installation, input.session_id);
    return await withNativeCaptureOutbox(config, async db => {
      db.exec(`CREATE TABLE IF NOT EXISTS codex_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),file TEXT NOT NULL,offset INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS codex_turns(turn_id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,operator_turn INTEGER NOT NULL);`);
      if (input.hook_event_name === 'SessionStart') {
        if (!['startup', 'resume', 'clear', 'compact'].includes(String(input.source))) fail('memory_codex_source_not_operator');
        db.prepare('INSERT OR IGNORE INTO codex_checkpoint(id,file,offset) VALUES(1,?,?)').run(source.file, source.size);
        if (input.source === 'compact' || input.source === 'clear') {
          db.prepare('UPDATE codex_checkpoint SET file=?,offset=? WHERE id=1').run(source.file, source.size);
        }
        audit('native-session-observed');
        createNativeCaptureBridge(config).kick(); // Recover durable ready rows without importing earlier text.
        return { initialized: true, historyImported: false };
      }
      const checkpoint = db.prepare('SELECT file,offset FROM codex_checkpoint WHERE id=1').get();
      if (!checkpoint || checkpoint.file !== source.file) fail('memory_codex_session_not_started');
      if (typeof input.turn_id !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(input.turn_id)) fail('memory_codex_event_invalid');
      const turn = input.turn_id, eventId = nativeCaptureEventId('codex', config.hostSessionId, turn);
      if (input.hook_event_name === 'UserPromptSubmit') {
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) fail('memory_codex_source_unsupported');
        const hash = digest(input.prompt);
        const verifiedMetadata = promptMetadata(source.file, source.size, turn, source.legacyEvents, source.source);
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = db.prepare('SELECT digest FROM codex_turns WHERE turn_id=?').get(turn);
          if (previous && previous.digest !== hash) fail('memory_event_changed');
          db.prepare("INSERT OR IGNORE INTO codex_turns(turn_id,digest,state,operator_turn) VALUES(?,?,'pending',?)").run(turn, hash, Number(verifiedMetadata));
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        audit('native-prompt-digest-staged', undefined, eventId);
        return { stagedDigest: true, bodyCaptured: false };
      }
      const pending = db.prepare('SELECT digest,state,operator_turn FROM codex_turns WHERE turn_id=?').get(turn);
      if (!pending || pending.state !== 'pending') return { ignored: 'no_unconfirmed_prompt' };
      if (typeof input.stop_hook_active !== 'boolean') fail('memory_codex_source_unsupported');
      if (input.stop_hook_active) {
        db.prepare("UPDATE codex_turns SET state='ignored' WHERE turn_id=? AND state='pending'").run(turn);
        db.prepare('UPDATE codex_checkpoint SET offset=MAX(offset,?) WHERE id=1').run(source.size);
        audit('native-continuation-ignored', undefined, eventId);
        return { ignored: 'automatic_continuation' };
      }
      const body = currentOperator(source.file, Number(checkpoint.offset), source.size, turn, String(pending.digest), source.legacyEvents, source.source, pending.operator_turn === 1);
      const ack = await enqueueNativeCapture(config, { eventId, nativeMessageId: turn, sourceText: body });
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE codex_turns SET state='queued' WHERE turn_id=? AND state='pending'").run(turn);
        db.prepare('UPDATE codex_checkpoint SET offset=MAX(offset,?) WHERE id=1').run(source.size);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      audit('native-capture-durable', undefined, eventId);
      createNativeCaptureBridge(config).kick();
      return ack;
    });
  } catch (error) {
    try { audit('native-capture-error', error instanceof DomainError ? error.code : 'memory_codex_capture_failed'); } catch { /* Never expose source text in diagnostics. */ }
    throw error;
  }
}

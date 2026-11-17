// Thin opt-in native-capture strategy over the established governance checks.
// --check does not open a DB, spawn a harness, read credentials or call services.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { nativeQueueEvidence, runPersonalGovernance } from './native-memory-personal-governance.mjs';
import { nativeCaptureEventId } from '../../cli/dist/memory-native-capture.js';

const hash = text => createHash('sha256').update(text).digest('hex');
export function checkNativeCaptureEvidence() {
  const source = { harness: 'opencode', nativeSessionId: 'ses_operator', memorySession: 'native-project-operator',
    nativeMessageId: 'msg_operator', sourceText: '这个项目我偏好先列验证结果。' };
  const eventId = nativeCaptureEventId(source.harness, source.nativeSessionId, source.nativeMessageId);
  const payload_json = JSON.stringify({ sessionId: source.memorySession, eventId, sourceText: source.sourceText });
  const row = { session_key: source.memorySession, event_key: eventId, payload_json, source_hash: hash(payload_json) };
  assert.equal(nativeQueueEvidence(source, [row]), true);
  for (const wrong of [[], [row, row], [{ ...row, session_key: 'different-project-session' }], [{ ...row, event_key: 'assistant-message' }],
    [{ ...row, source_hash: '0'.repeat(64) }], [{ ...row, payload_json: '{}' }]]) assert.equal(nativeQueueEvidence(source, wrong), false);
  assert.equal(nativeQueueEvidence({ ...source, sourceText: '别的原文' }, [row]), false);
  assert.equal(nativeQueueEvidence({ ...source, nativeMessageId: 'msg_tool' }, [row]), false);
  return { offlineOnly: true, modelRequests: 0, serviceRequests: 0, databaseConnections: 0, nativeHarnessProcesses: 0,
    evidenceCases: 9, productionModel: 'workbuddy/deepseek-v4.1-flash', explicitNativeSessionsOnly: true,
    controllerForwardingForbidden: true, sharedAndPrivateGovernanceChecksReused: 9 };
}

export const runNativeCaptureGovernance = options => runPersonalGovernance({ ...options, includeOpenCode: true, nativeCapture: true });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, 'run-id': { type: 'string' },
    'include-opencode': { type: 'boolean', default: true } } });
  if (values.check) console.log(JSON.stringify(checkNativeCaptureEvidence()));
  else {
    const runId = values['run-id'] ?? new Date().toISOString().replace(/[-:.TZ]/gu, '') + '-' + randomBytes(4).toString('hex');
    const { report, output } = await runNativeCaptureGovernance({ runId });
    console.log(JSON.stringify({ accepted: report.accepted, mechanicalAccepted: report.mechanicalAccepted, modelSemanticReview: report.modelSemanticReview.status,
      output, failure: report.failure ?? null, cleanupComplete: report.cleanup.externalResourcesRemoved && report.cleanup.databaseRemoved }));
    if (!report.mechanicalAccepted) process.exitCode = 1;
  }
}

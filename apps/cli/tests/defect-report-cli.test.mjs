import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { schema } from '@team-synergy/persistence';
import { createHttpTestContext, insertMember, insertProject, insertTeam, insertUser, testCode } from './http-test-helpers.mjs';

test('CLI reports defect facts and mixed evidence over HTTP, downloads exact bytes and respects project access', async t => {
  const context = await createHttpTestContext(import.meta.url);
  t.after(() => context.cleanup());
  const team = await insertTeam(context.db);
  const project = await insertProject(context.db, { code: testCode(101), teamId: team.id });
  const [feature] = await context.db.insert(schema.features).values({
    project_id: project.id, code: testCode(102), title: 'Export',
  }).returning();
  const users = {};
  for (const [index, name] of ['reporter', 'viewer', 'outsider'].entries()) {
    const user = await insertUser(context.db, { code: testCode(110 + index), account: name, displayName: name });
    const token = 'defect-cli-fixture-' + name;
    await context.db.insert(schema.devices).values({ principal_id: user.id, device_name: name,
      credential_hash: createHash('sha256').update(token).digest('hex'), created_at: new Date().toISOString() });
    if (name !== 'outsider') {
      await insertMember(context.db, { principalId: user.id, projectId: project.id,
        role: name === 'viewer' ? 'viewer' : 'member', displayName: name });
    }
    users[name] = token;
  }
  async function cli(name, args, expectedStatus = 0) {
    const result = await context.runCli(['defect', ...args], { ACP_DEVICE_TOKEN: users[name] }, { cwd: context.tmp });
    assert.equal(result.status, expectedStatus, result.err || result.out);
    const envelope = JSON.parse(result.out);
    assert.equal(envelope.ok, expectedStatus === 0, result.out);
    return expectedStatus === 0 ? envelope.data : envelope.error;
  }
  const fileName = '原始结果.bin';
  const bytes = Buffer.from([0x00, 0xe9, 0xff, 0x09, 0x80, 0x0d, 0x0a]);
  writeFileSync(path.join(context.tmp, fileName), bytes);
  const title = '导出结果为空';
  const action = '进入报表\n点击导出';
  const expected = '下载完整的数据';
  const actual = '返回 HTTP 503';
  const log = 'GET /export\nHTTP/1.1 503';
  const url = 'https://example.org/trace?id=312';
  const report = ['report', '--feature', feature.code, '--title', title, '--severity', 'high',
    '--action', action, '--expected', expected, '--actual', actual];
  const created = await cli('reporter', [...report, '--evidence-text', log, '--evidence-url', url, '--evidence-file', fileName]);
  assert.equal(created.status, 'reported');
  const code = created.defect_code;
  const listArgs = ['list', '--project', project.code, '--feature', feature.code];
  const [row] = await cli('viewer', listArgs);
  assert.equal(row.defect_code, code);
  assert.equal(row.feature_code, feature.code);
  assert.equal(row.severity, 'high');
  assert.deepEqual([row.title, row.action_steps, row.expected_result, row.actual_result], [title, action, expected, actual]);
  assert.deepEqual(row.evidence, [{ kind: 'text', text: log }, { kind: 'link', url },
    { kind: 'file', file_name: fileName, mime_type: 'application/octet-stream', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }]);
  const download = await cli('viewer', ['download', code, '2', '--out', 'download.bin']);
  assert.deepEqual(readFileSync(download.file), bytes);
  assert.equal(download.size_bytes, bytes.length);
  assert.deepEqual(await cli('outsider', listArgs), []);
  const denied = await cli('outsider', ['download', code, '2', '--out', 'denied.bin'], 1);
  assert.match(denied.code, /forbidden/u);
  assert.equal(existsSync(path.join(context.tmp, 'denied.bin')), false);
  const noEvidence = await cli('reporter', report, 1);
  assert.equal(noEvidence.code, 'defect_report_invalid');
  assert.match(noEvidence.message, /证据/u);
  for (const [option, field] of [['--action', '操作步骤'], ['--expected', '预期结果'], ['--actual', '实际结果']]) {
    const invalid = [...report, '--evidence-text', log];
    invalid[invalid.indexOf(option) + 1] = '  ';
    const error = await cli('reporter', invalid, 1);
    assert.equal(error.code, 'defect_report_invalid');
    assert.ok(error.message.includes(field), error.message);
  }
  const stored = await context.db.select().from(schema.defects);
  assert.deepEqual(stored.map(item => item.code), [code]);
  const attachments = await context.db.select().from(schema.defectEvidenceFiles);
  assert.equal(attachments.length, 1);
  const [attachment] = attachments;
  assert.equal(attachment.defect_id, stored[0].id);
  assert.deepEqual(Buffer.from(attachment.content_base64, 'base64'), bytes);
  t.diagnostic(`Defect ${code}, viewer downloaded ${download.size_bytes} bytes, SHA-256 ${row.evidence[2].sha256}`);
});

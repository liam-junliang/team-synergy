import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb, publicCode } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-10-15T00:00:00Z';
  const team = await insertTeam(db, { name: 'Design team', created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Design project', current_snapshot: 1, created_at });
  const users = [];
  for (const [index, role] of ['owner', 'member', 'outsider'].entries()) {
    const user = await insertUser(db, { code: publicCode(index + 1), account: `design.${role}`, display_name: role, status: 'active', created_at });
    const token = `design-${role}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    if (role !== 'outsider') await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role, display_name: role, created_at });
    users.push({ ...user, headers: { authorization: `Bearer ${token}` } });
  }
  const [owner, member, outsider] = users;
  return { db, app, owner, member, outsider, root: `/projects/${project.code}/design-prototypes` };
}
afterEach(async () => { for (const { db, app } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });

test('prototype HTTP preserves exact attachment revisions and returns only metadata in JSON', async () => {
  const { app, owner, member, outsider, root } = await fixture();
  const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers,
    payload: { title: '源文件', content_kind: 'file', file_name: '交互稿.fig', file_mime_type: 'application/x-figma', file_content_base64: bytes.toString('base64') } });
  assert.equal(created.statusCode, 200, created.body);
  const original = created.json().data;
  assert.equal(original.file_size, bytes.length);
  assert.equal('file_content_base64' in original, false);
  assert.equal('file_content_base64' in original.revisions[0], false);
  const url = `/design-prototypes/${original.prototype_code}`;
  const revised = await app.inject({ method: 'PATCH', url, headers: owner.headers,
    payload: { title: '源文件', summary: '', notes_markdown: '说明更新', change_summary: '补充说明' } });
  assert.equal(revised.statusCode, 200, revised.body);
  assert.equal(revised.json().data.file_sha256, original.file_sha256);
  const replacement = await app.inject({ method: 'PATCH', url, headers: owner.headers,
    payload: { title: '源文件', summary: '', change_summary: '更新附件', content_kind: 'file', file_content_base64: Buffer.from('replacement').toString('base64') } });
  assert.equal(replacement.statusCode, 200, replacement.body);
  for (const revision of [1, 2]) {
    const file = await app.inject({ method: 'GET', url: `${url}/file?revision=${revision}`, headers: member.headers });
    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, bytes);
    assert.equal(file.headers['content-type'], 'application/octet-stream');
    assert.match(file.headers['content-disposition'], /^attachment;/);
    assert.match(file.headers['content-disposition'], /filename\*=UTF-8''%E4%BA%A4/);
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.equal(file.headers['cache-control'], 'private, no-store');
  }
  const current = await app.inject({ method: 'GET', url: `${url}/file`, headers: owner.headers });
  assert.equal(current.body, 'replacement');
  for (const suffix of ['', '?revision=1']) {
    const denied = await app.inject({ method: 'GET', url: `${url}/file${suffix}`, headers: outsider.headers });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error.code, 'design_prototype_forbidden');
    const anonymous = await app.inject({ method: 'GET', url: `${url}/file${suffix}` });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
  }
  for (const revision of ['0', '-1', '1.5', '1abc', '']) {
    const invalid = await app.inject({ method: 'GET', url: `${url}/file?revision=${revision}`, headers: owner.headers });
    assert.equal(invalid.statusCode, 422, invalid.body);
  }
  const missing = await app.inject({ method: 'GET', url: `${url}/file?revision=99`, headers: owner.headers });
  assert.equal(missing.statusCode, 404, missing.body);
});

test('prototype HTTP validates links, file names and Base64 and keeps existing HTML clients working', async () => {
  const { app, owner, root } = await fixture();
  for (const external_url of ['javascript:alert(1)', 'ftp://example.com/file', 'https://user:password@example.com/']) {
    const response = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: { title: 'Link', content_kind: 'url', external_url } });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'design_prototype_url_invalid');
  }
  for (const extra of [{ file_name: '../bad.fig', file_content_base64: 'YQ==' }, { file_name: 'good.fig', file_content_base64: 'bad!' }]) {
    const response = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: { title: 'File', content_kind: 'file', ...extra } });
    assert.equal(response.statusCode, 422, response.body);
  }
  const html = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: { title: 'HTML', html_content: '<html><body>Preview</body></html>' } });
  assert.equal(html.statusCode, 200, html.body);
  assert.equal(html.json().data.content_kind, 'html');
  const url = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: { title: 'Link', content_kind: 'url', external_url: 'https://example.com/design?node=1#frame' } });
  assert.equal(url.statusCode, 200, url.body);
  assert.equal(url.json().data.external_url, 'https://example.com/design?node=1#frame');
  const noFile = await app.inject({ method: 'GET', url: `/design-prototypes/${url.json().data.prototype_code}/file`, headers: owner.headers });
  assert.equal(noFile.statusCode, 404, noFile.body);
});

test('prototype HTTP accepts file uploads above the global JSON body limit on create and revision', async () => {
  const { app, owner, root } = await fixture();
  const bytes = Buffer.alloc(7 * 1024 * 1024, 42);
  const payload = { title: 'Large file', content_kind: 'file', file_name: 'large.psd', file_content_base64: bytes.toString('base64') };
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().data.file_size, bytes.length);
  const revised = await app.inject({ method: 'PATCH', url: `/design-prototypes/${created.json().data.prototype_code}`, headers: owner.headers,
    payload: { ...payload, summary: '', change_summary: '重新上传' } });
  assert.equal(revised.statusCode, 200, revised.body);
  assert.equal(revised.json().data.file_sha256, createHash('sha256').update(bytes).digest('hex'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createProjectDocumentUseCases, createTestingUseCases } from '../dist/index.js';
import { insertUser, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const data = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const error = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, code); };

async function setup() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'testing.library.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'author', account: 'testing.library.author', displayName: 'Author', projectRole: 'member' },
    { key: 'viewer', account: 'testing.library.viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  const outsider = await insertUser(db, { account: 'testing.library.outsider', displayName: 'Outsider' });
  return { ...seeded, db, outsider, docs: createProjectDocumentUseCases(db), testing: createTestingUseCases(db) };
}

test('test assets share source identity and exact historical content in the document library', async () => {
  const ctx = await setup();
  const base = { projectCode: ctx.project.code, principalCode: ctx.users.author.code };
  const asset = data(await ctx.testing.createAsset({ ...base, input: { title: 'Smoke guide', storage_kind: 'markdown', content: '# Initial\n\nFirst procedure' } }));
  const original = asset.revisions[0];
  const revised = data(await ctx.testing.reviseAsset({ code: asset.code, principalCode: base.principalCode,
    input: { base_revision: 1, change_summary: 'Correct steps', title: 'Smoke guide v2', content: '# Updated\n\nDistinct-search-token' } }));
  const library = data(await ctx.docs.listLibrary({ ...base, query: 'Distinct-search-token' }));
  const folder = library.folders.find(row => row.system_role === 'testing');
  const entry = library.documents.find(row => row.document_code === asset.code);
  assert.equal(entry.source_kind, 'testing');
  assert.equal(entry.folder_code, folder.folder_code);
  assert.equal(entry.kind, 'doc');
  assert.equal(entry.can_edit, false);
  assert.equal(entry.source_can_edit, true);
  assert.equal('content' in entry, false);
  const projected = data(await ctx.docs.getDocument(asset.code, ctx.users.viewer.code));
  assert.equal(projected.project_code, ctx.project.code);
  assert.equal(projected.current_revision, 2);
  assert.equal(projected.content, revised.content);
  assert.equal(projected.testing_asset.can_edit, false);
  assert.deepEqual(projected.testing_asset.revisions.find(row => row.revision === 1), original);
  assert.equal(projected.revisions.find(row => row.revision === 1).content, original.content);
  assert.equal((await ctx.db.select().from(schema.projectDocuments)).length, 0, 'Source must not be copied to project_documents');
});

test('testing system root rejects folder mutation, nesting and unrelated document moves', async () => {
  const ctx = await setup();
  const base = { projectCode: ctx.project.code, principalCode: ctx.users.owner.code };
  const library = data(await ctx.docs.listLibrary(base));
  const folder = library.folders.find(row => row.system_role === 'testing');
  assert.equal(folder.name, '测试资料');
  assert.equal(folder.parent_folder_code, null);
  assert.equal(folder.can_edit, false);
  assert.equal(folder.can_create_folder, false);
  const ordinary = data(await ctx.docs.createFolder({ ...base, name: 'Manuals' }));
  const document = data(await ctx.docs.createDocument({ ...base, title: 'Other', kind: 'doc', content: 'Preserved' }));
  for (const change of [{ name: 'Changed' }, { parentFolderCode: ordinary.folder_code }, { status: 'archived' }]) {
    error(await ctx.docs.updateFolder({ folderCode: folder.folder_code, principalCode: base.principalCode, ...change }), 'project_document_folder_system');
  }
  error(await ctx.docs.createFolder({ ...base, name: 'Nested', parentFolderCode: folder.folder_code }), 'project_document_folder_read_only');
  error(await ctx.docs.updateFolder({ folderCode: ordinary.folder_code, principalCode: base.principalCode, parentFolderCode: folder.folder_code }), 'project_document_folder_read_only');
  error(await ctx.docs.createDocument({ ...base, folderCode: folder.folder_code, kind: 'doc', title: 'Wrong', content: 'Wrong' }), 'project_document_folder_read_only');
  error(await ctx.docs.reviseDocument({ documentCode: document.document_code, principalCode: base.principalCode,
    folderCode: folder.folder_code, title: 'Other', content: 'Changed', changeSummary: 'Move' }), 'project_document_folder_read_only');
  assert.equal(data(await ctx.docs.getDocument(document.document_code, base.principalCode)).content, 'Preserved');
});

test('test file library index omits payload while reader preserves versioned bytes and denies outsiders', async () => {
  const ctx = await setup();
  const base = { projectCode: ctx.project.code, principalCode: ctx.users.author.code };
  const bytes = Buffer.from('console.log("smoke");\n');
  const file = { file_name: 'smoke.js', mime_type: 'text/javascript', content_base64: bytes.toString('base64'), size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const asset = data(await ctx.testing.createAsset({ ...base, input: { title: 'Smoke script', purpose: 'script', storage_kind: 'file', file } }));
  const library = data(await ctx.docs.listLibrary(base));
  assert.equal(JSON.stringify(library).includes(file.content_base64), false);
  const detail = data(await ctx.docs.getDocument(asset.code, ctx.users.viewer.code));
  assert.deepEqual(detail.testing_asset.file, file);
  assert.equal(detail.testing_asset.revisions[0].file.sha256, file.sha256);
  assert.equal((await ctx.docs.getDocument(asset.code, ctx.outsider.code)).ok, false);
  assert.equal((await ctx.docs.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.outsider.code })).ok, false);
});

test('downgraded author and archived project retain read-only test library history', async () => {
  const ctx = await setup();
  const asset = data(await ctx.testing.createAsset({ projectCode: ctx.project.code, principalCode: ctx.users.author.code,
    input: { title: 'Procedure', content: '# Read only' } }));
  await ctx.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  let detail = data(await ctx.docs.getDocument(asset.code, ctx.users.author.code));
  assert.equal(detail.source_can_edit, false);
  assert.equal(detail.testing_asset.can_edit, false);
  const denied = await ctx.testing.reviseAsset({ code: asset.code, principalCode: ctx.users.author.code,
    input: { base_revision: 1, change_summary: 'Forbidden', title: 'Changed' } });
  assert.equal(denied.ok, false);
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  detail = data(await ctx.docs.getDocument(asset.code, ctx.users.owner.code));
  assert.equal(detail.source_can_edit, false);
  assert.equal(detail.testing_asset.can_edit, false);
  assert.equal(detail.revisions.length, 1);
  assert.equal(detail.content, '# Read only');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createArchitectureDocumentUseCases } from '../dist/index.js';
import { seedWorkspaceProject, useTestDb, insertUser } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>架构</text></svg>';
const SOURCE = 'flowchart LR\n  Web --> API\n';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXxkAAAAASUVORK5CYII=';

async function seeded() {
  const db = fixture.db;
  const ctx = await seedWorkspaceProject(db, { teamName: 'Architecture Team', projectName: 'Architecture Project', users: [
    { key: 'author', account: 'architecture.author', displayName: 'Author', projectRole: 'member' },
    { key: 'owner', account: 'architecture.owner', displayName: 'Owner', projectRole: 'owner' },
    { key: 'reader', account: 'architecture.reader', displayName: 'Reader', projectRole: 'member' },
  ] });
  const outsider = await insertUser(db, { account: 'architecture.outsider', displayName: 'Outsider' });
  const uc = createArchitectureDocumentUseCases(db);
  const input = { projectCode: ctx.project.code, principalCode: ctx.users.author.code, title: '系统架构',
    summary: 'Web 与 API', contentKind: 'mermaid', sourceContent: SOURCE, previewSvg: SVG, notesMarkdown: '# 职责\n\nAPI 负责鉴权。' };
  return { db, ...ctx, outsider, uc, input };
}

test('architecture saves full immutable revisions and separates summary lists from source data', async () => {
  const { db, uc, input, project, users } = await seeded();
  const created = await uc.createDocument(input);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.data.document_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.equal(created.data.source_content, SOURCE, 'source bytes are preserved');
  assert.equal(created.data.can_edit, true);
  assert.equal(created.data.current_revision, 1);
  const original = created.data.revisions[0];
  assert.equal(original.title, input.title);
  assert.equal(original.created_by_user_code, users.author.code);
  const list = await uc.listDocuments({ projectCode: project.code, principalCode: users.reader.code, query: 'Web' });
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].can_edit, false);
  for (const field of ['source_content', 'preview_svg', 'notes_markdown', 'revisions']) assert.equal(field in list.data[0], false);
  const revised = await uc.reviseDocument({ documentCode: created.data.document_code, principalCode: users.owner.code,
    baseRevision: 1, changeSummary: '补充职责', title: '服务架构', notesMarkdown: '新增数据库职责。' });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.current_revision, 2);
  assert.equal(revised.data.preview_svg, SVG, 'notes-only changes retain matching preview');
  assert.deepEqual(revised.data.revisions[1], original);
  assert.equal(revised.data.revisions[0].title, '服务架构');
  assert.equal(revised.data.revisions[0].created_by_user_code, users.owner.code);
  const [document] = await db.select().from(schema.architectureDocuments).where(eq(schema.architectureDocuments.code, created.data.document_code));
  const audits = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entity_type, 'architecture_document'), eq(schema.auditEvents.entity_id, document.id)));
  assert.deepEqual(audits.map(a => a.action), ['architecture_document.created', 'architecture_document.revised']);
});

test('architecture access requires membership and only the author or Owner can revise', async () => {
  const { db, uc, input, project, users, outsider } = await seeded();
  const created = await uc.createDocument(input);
  const code = created.data.document_code;
  for (const result of [
    await uc.createDocument({ ...input, principalCode: outsider.code }),
    await uc.listDocuments({ projectCode: project.code, principalCode: outsider.code }),
    await uc.getDocument(code, outsider.code),
    await uc.reviseDocument({ documentCode: code, principalCode: users.reader.code, baseRevision: 1, changeSummary: 'no' }),
  ]) { assert.equal(result.ok, false); assert.equal(result.error.code, 'architecture_document_forbidden'); }
  const other = await seedWorkspaceProject(db, { teamLegacyCode: 'OTHER-TEAM', projectLegacyCode: 'OTHER-PROJECT', teamName: 'Other', projectName: 'Other', users: [
    { key: 'owner', account: 'architecture.other', displayName: 'Other', projectRole: 'owner' },
  ] });
  const otherList = await uc.listDocuments({ projectCode: other.project.code, principalCode: other.users.owner.code });
  assert.deepEqual(otherList.data, []);
  assert.equal((await uc.getDocument(code, other.users.owner.code)).error.code, 'architecture_document_forbidden');
  assert.equal((await uc.getDocument(code, users.reader.code)).data.can_edit, false);
  await db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, project.id));
  assert.equal((await uc.getDocument(code, users.owner.code)).data.can_edit, false);
  assert.equal((await uc.listDocuments({ projectCode: project.code, principalCode: users.author.code })).data[0].can_edit, false);
  assert.equal((await uc.reviseDocument({ documentCode: code, principalCode: users.author.code, baseRevision: 1, changeSummary: 'no' })).error.code, 'project_archived');
  assert.equal((await uc.createDocument(input)).error.code, 'project_archived');
});

test('architecture revisions reject stale bases and serialize concurrent updates without lost history', async () => {
  const { uc, input, users } = await seeded();
  const created = await uc.createDocument(input);
  const command = { documentCode: created.data.document_code, principalCode: users.author.code, baseRevision: 1, changeSummary: '并发编辑' };
  const results = await Promise.all([
    uc.reviseDocument({ ...command, sourceContent: 'flowchart LR\n A --> B' }),
    uc.reviseDocument({ ...command, sourceContent: 'flowchart LR\n X --> Y' }),
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.find(r => !r.ok).error.code, 'architecture_document_revision_conflict');
  const detail = await uc.getDocument(command.documentCode, users.author.code);
  assert.deepEqual(detail.data.revisions.map(r => r.revision), [2, 1]);
  assert.deepEqual(detail.data.revisions[1], created.data.revisions[0]);
  assert.equal(detail.data.preview_svg, null);
  for (const baseRevision of [undefined, 0, -1, 1.5, NaN]) {
    const invalid = await uc.reviseDocument({ ...command, baseRevision });
    assert.equal(invalid.error.code, 'architecture_document_base_revision_invalid');
  }
});

test('architecture keeps previews paired with their source and supports draw.io and image revisions', async () => {
  const { uc, input, users } = await seeded();
  const created = await uc.createDocument(input);
  const command = { documentCode: created.data.document_code, principalCode: users.author.code, changeSummary: '更新图源' };
  const drawio = '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
  const revision2 = await uc.reviseDocument({ ...command, baseRevision: 1, contentKind: 'drawio', sourceContent: drawio });
  assert.equal(revision2.ok, true, JSON.stringify(revision2));
  assert.equal(revision2.data.preview_svg, null);
  const revision3 = await uc.reviseDocument({ ...command, baseRevision: 2, previewSvg: SVG });
  assert.equal(revision3.data.preview_svg, SVG);
  assert.equal(revision3.data.source_content, drawio);
  const revision4 = await uc.reviseDocument({ ...command, baseRevision: 3, previewSvg: null });
  assert.equal(revision4.data.preview_svg, null);
  const revision5 = await uc.reviseDocument({ ...command, baseRevision: 4, contentKind: 'image', sourceContent: PNG });
  assert.equal(revision5.ok, true, JSON.stringify(revision5));
  assert.equal(revision5.data.source_content, PNG);
  assert.deepEqual(revision5.data.revisions.map(r => r.content_kind), ['image', 'drawio', 'drawio', 'drawio', 'mermaid']);
});

test('architecture rejects unsafe formats, invalid signatures and byte-sized overflows without creating records', async () => {
  const { db, uc, input } = await seeded();
  for (const extra of [
    { contentKind: 'html', sourceContent: '<html>no</html>' },
    { contentKind: 'drawio', sourceContent: '<!DOCTYPE mxfile [<!ENTITY x SYSTEM "file:///secret">]><mxfile>&x;</mxfile>' },
    { contentKind: 'drawio', sourceContent: '<svg/>' },
    { contentKind: 'image', sourceContent: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { contentKind: 'image', sourceContent: 'data:image/png;base64,' + Buffer.from('<html>not a PNG</html>').toString('base64') },
    { sourceContent: '界'.repeat(2 * 1024 * 1024 + 1) },
    { sourceContent: '  ' },
    { previewSvg: '<html>preview</html>' },
    { previewSvg: '<!DOCTYPE svg><svg/>' },
    { previewSvg: '<svg>' + '界'.repeat(700 * 1024) + '</svg>' },
    { notesMarkdown: 'a'.repeat(256 * 1024 + 1) },
  ]) {
    const invalid = await uc.createDocument({ ...input, ...extra });
    assert.equal(invalid.ok, false, JSON.stringify(extra).slice(0, 100));
    assert.notEqual(invalid.error.code, 'internal_error');
  }
  assert.deepEqual(await db.select().from(schema.architectureDocuments), []);
  assert.deepEqual(await db.select().from(schema.architectureDocumentRevisions), []);
});

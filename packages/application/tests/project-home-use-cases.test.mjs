import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createProjectHomeUseCases, createProjectDocumentUseCases, createProjectUseCasesProject } from '../dist/index.js';
import { seedWorkspaceProject, insertProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const success = (result) => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const failure = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, code); };
async function seededDb() {
  const db = fixture.db;
  const ctx = await seedWorkspaceProject(db, { projectName: 'Home project', users: [
    { key: 'owner', account: 'home.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'member', account: 'home.member', displayName: 'Member', projectRole: 'member' },
  ] });
  const home = createProjectHomeUseCases(db);
  const docs = createProjectDocumentUseCases(db);
  const legacy = createProjectUseCasesProject(db);
  const document = async (title, principalCode = ctx.users.owner.code, folderCode) => success(await docs.createDocument({
    projectCode: ctx.project.code, principalCode, folderCode, kind: 'general', title, content: `# ${title}\n\n${title} body`,
  }));
  const bind = (bindings, principalCode = ctx.users.owner.code) => home.updateHome({ projectCode: ctx.project.code, principalCode, bindings });
  const view = (principalCode = ctx.users.owner.code) => home.getHome(ctx.project.code, principalCode);
  return { db, ...ctx, home, docs, legacy, document, bind, view };
}

test('project home: explicit roles reuse documents, members read and only Owners can bind', async () => {
  const ctx = await seededDb();
  const general = await ctx.document('Regular handoff');
  const empty = success(await ctx.view(ctx.users.member.code));
  assert.match(empty.standards_folder_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.deepEqual(empty, { project_code: ctx.project.code, can_edit: false, overview: null, guide: null, standards: [], standards_folder_code: empty.standards_folder_code });
  assert.equal(success(await ctx.legacy.getProjectDocument(ctx.project.code, ctx.users.owner.code)).document_code, null);
  const overview = await ctx.document('Overview');
  const guide = await ctx.document('Start guide', ctx.users.member.code);
  const standards = await ctx.document('Coding standards', ctx.users.owner.code, empty.standards_folder_code);
  failure(await ctx.bind({ overview_document_code: general.document_code }, ctx.users.member.code), 'project_home_forbidden');
  const bound = success(await ctx.bind({ overview_document_code: overview.document_code, guide_document_code: guide.document_code }));
  assert.equal(bound.overview.document_code, overview.document_code);
  assert.equal(bound.guide.document_code, guide.document_code);
  assert.deepEqual(bound.standards.map(document => document.document_code), [standards.document_code]);
  const viewed = success(await ctx.view(ctx.users.member.code));
  assert.match(viewed.overview.content, /Overview body/);
  assert.equal(viewed.overview.can_edit, false);
  assert.equal(viewed.guide.can_edit, true);
  const [outsider] = await ctx.db.insert(schema.users).values({ account: 'home.outsider', display_name: 'Outsider', status: 'active', created_at: 't0' }).returning();
  failure(await ctx.view(outsider.code), 'project_forbidden');
  failure(await ctx.bind({ guide_document_code: guide.document_code }, outsider.code), 'project_home_forbidden');
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entity_id, ctx.project.id), eq(schema.auditEvents.action, 'project.home_updated')));
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].payload).overview_document_code, overview.document_code);
});

test('project home: reject invalid, archived and foreign links atomically; cleared roles preserve documents', async () => {
  const ctx = await seededDb();
  const overview = await ctx.document('Overview');
  const archived = await ctx.document('Archived');
  success(await ctx.bind({ overview_document_code: overview.document_code }));
  success(await ctx.docs.reviseDocument({ documentCode: archived.document_code, principalCode: ctx.users.owner.code,
    title: archived.title, content: 'Archived body', changeSummary: 'Archive', status: 'archived' }));
  const other = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Other project' });
  const [foreign] = await ctx.db.insert(schema.projectDocuments).values({ project_id: other.id, title: 'Private other project', content: 'secret',
    created_by: ctx.users.owner.id, updated_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  failure(await ctx.bind({ overview_document_code: null, guide_document_code: foreign.code }), 'project_home_document_invalid');
  assert.equal(success(await ctx.view()).overview.document_code, overview.document_code);
  failure(await ctx.bind({ guide_document_code: archived.document_code }), 'project_home_document_archived');
  for (const bindings of [{}, { overview_document_code: undefined }, { guide_document_code: '' }, { guide_document_code: 'bad' }, { unknown: null }]) {
    failure(await ctx.bind(bindings), 'project_home_invalid');
  }
  for (const standards_document_code of [null, 42, overview.document_code]) {
    failure(await ctx.bind({ overview_document_code: null, standards_document_code }), 'project_home_standards_managed');
    assert.equal(success(await ctx.view()).overview.document_code, overview.document_code);
  }
  const cleared = success(await ctx.bind({ overview_document_code: null }));
  assert.equal(cleared.overview, null);
  assert.match(success(await ctx.docs.getDocument(overview.document_code, ctx.users.member.code)).content, /Overview body/);
});

test('project home: concurrent partial updates preserve other roles and document updates remain visible', async () => {
  const ctx = await seededDb();
  const overview = await ctx.document('Overview');
  const guide = await ctx.document('Guide');
  const folderCode = success(await ctx.view()).standards_folder_code;
  const standards = await ctx.document('Standards', ctx.users.owner.code, folderCode);
  const results = await Promise.all([ctx.bind({ guide_document_code: guide.document_code }), ctx.bind({ overview_document_code: overview.document_code })]);
  results.forEach(success);
  const view = success(await ctx.view());
  assert.equal(view.overview.document_code, overview.document_code);
  assert.equal(view.guide.document_code, guide.document_code);
  assert.equal(view.standards[0].document_code, standards.document_code);
  success(await ctx.docs.reviseDocument({ documentCode: guide.document_code, principalCode: ctx.users.owner.code,
    title: 'Updated guide', content: 'New onboarding steps', changeSummary: 'Update guide' }));
  const updated = success(await ctx.view());
  assert.equal(updated.guide.revision, 2);
  assert.equal(updated.guide.content, 'New onboarding steps');
  const cleared = success(await ctx.bind({ guide_document_code: null }));
  assert.equal(cleared.overview.document_code, overview.document_code);
  assert.equal(cleared.guide, null);
  assert.equal(cleared.standards[0].document_code, standards.document_code);
});

test('project standards: provision is authenticated and concurrent home/library reads converge without adopting an ordinary folder', async () => {
  const ctx = await seededDb();
  const [ordinary] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id, name: '项目规范',
    created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  await ctx.document('Unrelated rules', ctx.users.owner.code, ordinary.code);
  const [outsider] = await ctx.db.insert(schema.users).values({ account: 'standards.outsider', display_name: 'Outsider', status: 'active', created_at: 't0' }).returning();
  failure(await ctx.view(outsider.code), 'project_forbidden');
  failure(await ctx.docs.listLibrary({ projectCode: ctx.project.code, principalCode: outsider.code }), 'project_document_forbidden');
  assert.equal((await ctx.db.select().from(schema.projectDocumentFolders)).length, 1);
  const [first, library, second] = (await Promise.all([
    ctx.view(), ctx.docs.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.member.code }), ctx.view(ctx.users.member.code),
  ])).map(success);
  assert.equal(first.standards_folder_code, second.standards_folder_code);
  assert.deepEqual(first.standards, []);
  const roots = library.folders.filter(folder => folder.system_role === 'standards');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].folder_code, first.standards_folder_code);
  assert.equal(roots[0].can_edit, false);
  assert.equal(roots[0].parent_folder_code, null);
  const original = library.folders.find(folder => folder.folder_code === ordinary.code);
  assert.equal(original.name, `项目规范（原目录 ${ordinary.code}）`);
  assert.equal(original.system_role, null);
  assert.equal(library.documents[0].folder_code, ordinary.code);
  const rows = await ctx.db.select().from(schema.projectDocumentFolders);
  assert.equal(rows.filter(folder => folder.system_role === 'standards').length, 1);
  assert.equal(rows.find(folder => folder.system_role === 'standards').created_by, null);
});

test('project standards: active recursive membership, stable ordering and latest revisions survive folder and document moves', async () => {
  const ctx = await seededDb();
  const root = success(await ctx.view()).standards_folder_code;
  // Reproduce the pre-existing standards tree; new folders are no longer accepted below a system root.
  const folder = async (name, parentFolderCode) => {
    const [parent] = parentFolderCode ? await ctx.db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.code, parentFolderCode)) : [];
    const [created] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id, parent_id: parent?.id ?? null,
      name, created_by: ctx.users.owner.id, created_at: 'legacy', updated_at: 'legacy' }).returning();
    return { ...created, folder_code: created.code };
  };
  const child = await folder('工程约定', root);
  const nested = await folder('Web', child.folder_code);
  const hidden = await folder('Archived branch', root);
  const hiddenChild = await folder('Still active child', hidden.folder_code);
  const other = await folder('Ordinary');
  const direct = await ctx.document('B root', ctx.users.owner.code, root);
  const nestedDoc = await ctx.document('A nested', ctx.users.member.code, nested.folder_code);
  const sameTitle = await ctx.document('A nested', ctx.users.owner.code, child.folder_code);
  await ctx.document('Hidden direct', ctx.users.owner.code, hidden.folder_code);
  await ctx.document('Hidden descendant', ctx.users.owner.code, hiddenChild.folder_code);
  await ctx.document('Outside', ctx.users.owner.code, other.folder_code);
  const archived = await ctx.document('Archived document', ctx.users.owner.code, root);
  success(await ctx.docs.updateFolder({ folderCode: hidden.folder_code, principalCode: ctx.users.owner.code, status: 'archived' }));
  success(await ctx.docs.reviseDocument({ documentCode: archived.document_code, principalCode: ctx.users.owner.code,
    title: archived.title, content: 'Archived document body', changeSummary: 'Archive', status: 'archived' }));
  // A stale retired link must never make unrelated documents mandatory again.
  const [outside] = await ctx.db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.title, 'Outside'));
  await ctx.db.update(schema.projects).set({ standards_document_id: outside.id }).where(eq(schema.projects.id, ctx.project.id));
  const codes = () => ctx.view().then(success).then(home => home.standards.map(document => document.document_code));
  assert.deepEqual(await codes(), [nestedDoc.document_code, sameTitle.document_code].sort().concat(direct.document_code));
  const read = success(await ctx.view(ctx.users.member.code));
  assert.equal(read.standards.find(document => document.document_code === nestedDoc.document_code).can_edit, true);
  assert.equal(read.standards.find(document => document.document_code === direct.document_code).can_edit, false);
  success(await ctx.docs.reviseDocument({ documentCode: nestedDoc.document_code, principalCode: ctx.users.member.code,
    title: nestedDoc.title, content: 'Current required rule', changeSummary: 'Clarify rule' }));
  const current = success(await ctx.view()).standards.find(document => document.document_code === nestedDoc.document_code);
  assert.equal(current.content, 'Current required rule');
  assert.equal(current.revision, 2);
  success(await ctx.docs.updateFolder({ folderCode: child.folder_code, principalCode: ctx.users.owner.code, parentFolderCode: other.folder_code }));
  assert.deepEqual(await codes(), [direct.document_code]);
  failure(await ctx.docs.updateFolder({ folderCode: child.folder_code, principalCode: ctx.users.owner.code, parentFolderCode: root }), 'project_document_folder_read_only');
  assert.equal((await codes()).length, 1);
  success(await ctx.docs.reviseDocument({ documentCode: direct.document_code, principalCode: ctx.users.owner.code,
    title: direct.title, content: 'Root body', changeSummary: 'Move out', folderCode: null }));
  assert.equal((await codes()).includes(direct.document_code), false);
  assert.equal(success(await ctx.docs.getDocument(direct.document_code, ctx.users.owner.code)).revisions.length, 2);
});

test('project home: archive races produce no readable archived home document; legacy save cannot revive one', async () => {
  const ctx = await seededDb();
  const overview = await ctx.document('Overview');
  const [binding, archive] = await Promise.all([
    ctx.bind({ overview_document_code: overview.document_code }),
    ctx.docs.reviseDocument({ documentCode: overview.document_code, principalCode: ctx.users.owner.code,
      title: overview.title, content: 'Old body', changeSummary: 'Archive', status: 'archived' }),
  ]);
  if (!binding.ok) failure(binding, 'project_home_document_archived');
  success(archive);
  assert.equal(success(await ctx.view()).overview, null);
  // Force an existing archived link to check the defensive legacy path even if archive won the race.
  const [stored] = await ctx.db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.code, overview.document_code));
  await ctx.db.update(schema.projects).set({ overview_document_id: stored.id }).where(eq(schema.projects.id, ctx.project.id));
  assert.equal(success(await ctx.legacy.getProjectDocument(ctx.project.code, ctx.users.owner.code)).document_code, null);
  failure(await ctx.legacy.saveProjectDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, title: 'New', content: 'Must not resurrect' }), 'project_home_document_archived');
  success(await ctx.bind({ overview_document_code: null }));
  const fresh = success(await ctx.legacy.saveProjectDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, title: 'New overview', content: 'New body' }));
  assert.notEqual(fresh.document_code, overview.document_code);
  assert.equal(success(await ctx.docs.getDocument(overview.document_code, ctx.users.owner.code)).status, 'archived');
});

test('project home: legacy endpoint creates a dedicated overview and serializes concurrent revisions', async () => {
  const ctx = await seededDb();
  const unrelated = await ctx.document('Must remain unchanged');
  assert.equal(success(await ctx.legacy.getProjectDocument(ctx.project.code, ctx.users.owner.code)).content, '');
  const command = { projectCode: ctx.project.code, principalCode: ctx.users.owner.code, title: 'Overview', content: 'First text' };
  const results = await Promise.all([ctx.legacy.saveProjectDocument(command), ctx.legacy.saveProjectDocument({ ...command, content: 'Second text' })]);
  const saved = results.map(success);
  assert.equal(saved[0].document_code, saved[1].document_code);
  assert.deepEqual(saved.map(doc => doc.revision).sort(), [1, 2]);
  assert.notEqual(saved[0].document_code, unrelated.document_code);
  assert.match(success(await ctx.docs.getDocument(unrelated.document_code, ctx.users.owner.code)).content, /Must remain unchanged body/);
  assert.equal(success(await ctx.view()).overview.document_code, saved[0].document_code);
  const replacement = await ctx.document('Explicit replacement');
  success(await ctx.bind({ overview_document_code: replacement.document_code }));
  const updated = success(await ctx.legacy.saveProjectDocument({ ...command, content: 'Explicit replacement content' }));
  assert.equal(updated.document_code, replacement.document_code);
  assert.equal(updated.revision, 2);
  assert.equal(success(await ctx.docs.getDocument(saved[0].document_code, ctx.users.owner.code)).current_revision, 2);
});

test('project home migration backfill requires an unambiguous same-project audit document reference', async () => {
  const ctx = await seededDb();
  const overview = await ctx.document('Unambiguously audited overview');
  await ctx.document('Earlier generic document is not a fallback');
  const projects = [ctx.project];
  for (const name of ['No reference', 'Ambiguous', 'Archived', 'Cross-project', 'Malformed audit']) projects.push(await insertProject(ctx.db, { teamId: ctx.team.id, name }));
  const addDoc = async (project, title, status = 'active') => (await ctx.db.insert(schema.projectDocuments).values({ project_id: project.id, title, content: title,
    status, created_by: ctx.users.owner.id, updated_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning())[0];
  const audit = (project, payload) => ctx.db.insert(schema.auditEvents).values({ entity_type: 'project', entity_id: project.id, principal_id: ctx.users.owner.id,
    action: 'project.document_created', base_snapshot: 0, payload, timestamp: 't0' });
  await audit(ctx.project, JSON.stringify({ document_code: overview.document_code }));
  await addDoc(projects[1], 'Only one generic doc still must not be guessed');
  const first = await addDoc(projects[2], 'Candidate A');
  const second = await addDoc(projects[2], 'Candidate B');
  await audit(projects[2], JSON.stringify({ document_code: first.code }));
  await audit(projects[2], JSON.stringify({ document_code: second.code }));
  const archived = await addDoc(projects[3], 'Archived candidate', 'archived');
  await audit(projects[3], JSON.stringify({ document_code: archived.code }));
  await audit(projects[4], JSON.stringify({ document_code: overview.document_code }));
  await audit(projects[5], '{malformed');
  const migration = readFileSync(new URL('../../persistence/drizzle/0029_project_home_documents.sql', import.meta.url), 'utf8');
  const backfill = migration.split('--> statement-breakpoint').at(-1);
  await ctx.db.execute(sql.raw(backfill));
  const rows = await ctx.db.select().from(schema.projects);
  const [overviewRow] = await ctx.db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.code, overview.document_code));
  assert.equal(rows.find(row => row.id === ctx.project.id).overview_document_id, overviewRow.id);
  for (const project of projects.slice(1)) assert.equal(rows.find(row => row.id === project.id).overview_document_id, null, project.name);
  assert.equal(success(await ctx.view()).overview.document_code, overview.document_code);
});

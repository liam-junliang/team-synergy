import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import {
  createArchitectureDocumentUseCases, createDesignPrototypeUseCases, createProjectDocumentUseCases,
  createProjectHomeUseCases, createProjectStructureUseCases, createRequirementCollaborationUseCases,
  createRequirementDocumentUseCases,
} from '../dist/index.js';
import { addTeamMember, insertUser, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
function data(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
function denied(result) { assert.equal(result.ok, false, JSON.stringify(result)); assert.match(result.error.code, /forbidden|archived/); }

async function setup(policy = 'private') {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'docs.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'admin', account: 'docs.admin', displayName: 'Admin', projectRole: 'admin' },
    { key: 'author', account: 'docs.author', displayName: 'Author', projectRole: 'member' },
  ] });
  await db.update(schema.projects).set({ member_policy: policy, owner_principal_id: seeded.users.owner.id }).where(eq(schema.projects.id, seeded.project.id));
  const inherited = await insertUser(db, { account: 'docs.inherited', displayName: 'Inherited' });
  await addTeamMember(db, { teamId: seeded.team.id, principalId: inherited.id, role: 'member', displayName: inherited.display_name });
  const outsider = await insertUser(db, { account: 'docs.outsider', displayName: 'Outsider' });
  const structure = createProjectStructureUseCases(db);
  const module = data(await structure.createModule({ projectCode: seeded.project.code, principalCode: seeded.users.admin.code, name: 'Delivery' }));
  return { db, ...seeded, inherited, outsider, module, structure,
    docs: createProjectDocumentUseCases(db), requirements: createRequirementDocumentUseCases(db),
    architecture: createArchitectureDocumentUseCases(db), designs: createDesignPrototypeUseCases(db),
    home: createProjectHomeUseCases(db), collaboration: createRequirementCollaborationUseCases(db) };
}

async function createMaterials(ctx, principal = ctx.users.author) {
  const base = { projectCode: ctx.project.code, principalCode: principal.code };
  const folder = data(await ctx.docs.createFolder({ ...base, name: 'Engineering' }));
  const document = data(await ctx.docs.createDocument({ ...base, folderCode: folder.folder_code, kind: 'doc', title: 'Guide', content: '# Guide\n\nInstructions.' }));
  const requirement = data(await ctx.requirements.createDocument({ ...base, moduleCode: ctx.module.module_code, title: 'Requirements', summary: 'Scope', content: '# Requirements\n\nScope.' }));
  const architecture = data(await ctx.architecture.createDocument({ ...base, title: 'Architecture', contentKind: 'mermaid', sourceContent: 'flowchart LR\n Web --> API' }));
  const design = data(await ctx.designs.createPrototype({ ...base, title: 'Prototype', contentKind: 'url', externalUrl: 'https://example.com/prototype' }));
  return { folder, document, requirement, architecture, design };
}

function reviseMaterials(ctx, material, principalCode) {
  return [
    ctx.docs.reviseDocument({ documentCode: material.document.document_code, principalCode, title: 'Guide v2', content: '# Updated', changeSummary: 'Update' }),
    ctx.requirements.reviseDocument({ documentCode: material.requirement.document_code, principalCode, moduleCode: ctx.module.module_code, title: 'Requirements v2', summary: 'Updated', content: '# Updated', changeSummary: 'Update' }),
    ctx.architecture.reviseDocument({ documentCode: material.architecture.document_code, principalCode, baseRevision: 1, title: 'Architecture v2', changeSummary: 'Update' }),
    ctx.designs.revisePrototype({ prototypeCode: material.design.prototype_code, principalCode, title: 'Prototype v2', summary: 'Updated', changeSummary: 'Update' }),
  ];
}

test('former document authors downgraded to Viewer retain reads but cannot revise any material or folder', async () => {
  const ctx = await setup('team_write');
  const material = await createMaterials(ctx);
  data(await ctx.home.updateHome({ projectCode: ctx.project.code, principalCode: ctx.users.admin.code, bindings: { overview_document_code: material.document.document_code } }));
  await ctx.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  const principalCode = ctx.users.author.code;
  for (const result of await Promise.all(reviseMaterials(ctx, material, principalCode))) denied(result);
  denied(await ctx.docs.updateFolder({ folderCode: material.folder.folder_code, principalCode, name: 'Unauthorized rename' }));
  for (const result of await Promise.all([
    ctx.docs.getDocument(material.document.document_code, principalCode),
    ctx.requirements.getDocument(material.requirement.document_code, principalCode),
    ctx.architecture.getDocument(material.architecture.document_code, principalCode),
    ctx.designs.getPrototype(material.design.prototype_code, principalCode),
  ])) assert.equal(data(result).can_edit, false);
  const home = data(await ctx.home.getHome(ctx.project.code, principalCode));
  assert.equal(home.can_edit, false);
  assert.equal(home.overview.can_edit, false);
  const library = data(await ctx.docs.listLibrary({ projectCode: ctx.project.code, principalCode }));
  assert.equal(library.can_create, false);
  assert.ok(library.folders.every(folder => !folder.can_edit && !folder.can_create_folder));
  assert.ok(library.documents.every(document => !document.can_edit && !document.source_can_edit));
  assert.equal(data(await ctx.architecture.getDocument(material.architecture.document_code, principalCode)).current_revision, 1);
});

test('project Admin can maintain another author’s documents without becoming their historical author', async () => {
  const ctx = await setup();
  const material = await createMaterials(ctx);
  for (const result of await Promise.all(reviseMaterials(ctx, material, ctx.users.admin.code))) data(result);
  const architecture = data(await ctx.architecture.getDocument(material.architecture.document_code, ctx.users.admin.code));
  assert.equal(architecture.owner_principal_code, ctx.users.author.code);
  assert.equal(architecture.current_revision, 2);
  assert.equal(architecture.revisions.find(revision => revision.revision === 1).created_by_user_code, ctx.users.author.code);
});

test('team_read grants material and history reads without an explicit project row and denies new content', async () => {
  const ctx = await setup('team_read');
  const material = await createMaterials(ctx);
  const principalCode = ctx.inherited.code;
  const base = { projectCode: ctx.project.code, principalCode };
  assert.equal(data(await ctx.docs.listLibrary(base)).documents.length, 3);
  assert.equal(data(await ctx.requirements.listDocuments(base)).length, 1);
  assert.equal(data(await ctx.architecture.listDocuments(base)).length, 1);
  assert.equal(data(await ctx.designs.listPrototypes(base)).length, 1);
  for (const result of await Promise.all([
    ctx.docs.getDocument(material.document.document_code, principalCode),
    ctx.requirements.getDocument(material.requirement.document_code, principalCode),
    ctx.architecture.getDocument(material.architecture.document_code, principalCode),
    ctx.designs.getPrototype(material.design.prototype_code, principalCode),
    ctx.home.getHome(ctx.project.code, principalCode),
  ])) data(result);
  denied(await ctx.docs.createDocument({ ...base, kind: 'doc', title: 'Blocked', content: '# Blocked' }));
  denied(await ctx.collaboration.createIdea({ ...base, title: 'Blocked' }));
  denied(await ctx.structure.createModule({ ...base, name: 'Blocked' }));
  denied(await ctx.docs.getDocument(material.document.document_code, ctx.outsider.code));
  denied(await ctx.architecture.getDocument(material.architecture.document_code, ctx.outsider.code));
});

test('team_write allows authoring but not structural management and revocation removes material reads', async () => {
  const ctx = await setup('team_write');
  const material = await createMaterials(ctx, ctx.inherited);
  for (const result of await Promise.all(reviseMaterials(ctx, material, ctx.inherited.code))) data(result);
  denied(await ctx.structure.createModule({ projectCode: ctx.project.code, principalCode: ctx.inherited.code, name: 'Forbidden module' }));
  denied(await ctx.requirements.createDocument({ projectCode: ctx.project.code, principalCode: ctx.inherited.code, moduleKey: 'Implicit forbidden module', title: 'Blocked', content: '# Blocked' }));
  const modules = data(await ctx.structure.listModules({ projectCode: ctx.project.code, principalCode: ctx.users.admin.code }));
  assert.equal(modules.length, 1);
  await ctx.db.delete(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, ctx.team.id), eq(schema.teamMembers.principal_id, ctx.inherited.id)));
  for (const result of await Promise.all([
    ctx.docs.getDocument(material.document.document_code, ctx.inherited.code),
    ctx.requirements.getDocument(material.requirement.document_code, ctx.inherited.code),
    ctx.architecture.getDocument(material.architecture.document_code, ctx.inherited.code),
    ctx.designs.getPrototype(material.design.prototype_code, ctx.inherited.code),
  ])) denied(result);
});

test('Viewer status overrides historical idea, topic, entry and review ownership', async () => {
  const ctx = await setup('team_write');
  const material = await createMaterials(ctx);
  const base = { projectCode: ctx.project.code, principalCode: ctx.users.author.code };
  const idea = data(await ctx.collaboration.createIdea({ ...base, title: 'Idea' }));
  const topic = data(await ctx.collaboration.createTopic({ ...base, title: 'Topic' }));
  data(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: base.principalCode, entryType: 'comment', content: 'Comment' }));
  const topicBefore = data(await ctx.collaboration.getTopic(topic.topic_code, base.principalCode));
  const review = data(await ctx.collaboration.startDocumentReview({ documentCode: material.requirement.document_code, principalCode: base.principalCode }));
  await ctx.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  for (const result of await Promise.all([
    ctx.collaboration.updateIdea({ ideaCode: idea.idea_code, principalCode: base.principalCode, title: 'Blocked' }),
    ctx.collaboration.updateTopic({ topicCode: topic.topic_code, principalCode: base.principalCode, title: 'Blocked' }),
    ctx.collaboration.withdrawTopicEntry({ entryCode: topicBefore.entries[0].entry_code, principalCode: base.principalCode }),
    ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: base.principalCode, entryType: 'comment', content: 'Blocked' }),
    ctx.collaboration.voteDocumentReview({ reviewCode: review.review_code, principalCode: base.principalCode, vote: 'support' }),
    ctx.collaboration.closeDocumentReview({ reviewCode: review.review_code, principalCode: base.principalCode, conclusion: 'passed' }),
  ])) denied(result);
  const topicAfter = data(await ctx.collaboration.getTopic(topic.topic_code, base.principalCode));
  assert.equal(topicAfter.can_manage, false);
  assert.equal(topicAfter.can_decide, false);
  assert.equal(topicAfter.entries[0].can_withdraw, false);
});

test('members may discuss and vote while only project managers can decide or conclude a review', async () => {
  const ctx = await setup('team_write');
  const material = await createMaterials(ctx);
  const topic = data(await ctx.collaboration.createTopic({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, title: 'Scope decision' }));
  const review = data(await ctx.collaboration.startDocumentReview({ documentCode: material.requirement.document_code, principalCode: ctx.users.author.code }));
  for (const member of [ctx.users.author, ctx.inherited]) {
    data(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: member.code, entryType: 'comment', content: 'Discussion is allowed' }));
    data(await ctx.collaboration.voteDocumentReview({ reviewCode: review.review_code, principalCode: member.code, vote: 'support' }));
    denied(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: member.code, entryType: 'decision', content: 'Unauthorized decision' }));
    denied(await ctx.collaboration.closeDocumentReview({ reviewCode: review.review_code, principalCode: member.code, conclusion: 'passed' }));
    assert.equal(data(await ctx.collaboration.getTopic(topic.topic_code, member.code)).can_decide, false);
  }
  // The topic's author cannot bypass decision authorization through the status field.
  denied(await ctx.collaboration.updateTopic({ topicCode: topic.topic_code, principalCode: ctx.users.author.code, status: 'decided' }));
  assert.equal(data(await ctx.collaboration.getTopic(topic.topic_code, ctx.users.admin.code)).current_decision, null);
  data(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: ctx.users.admin.code, entryType: 'decision', content: 'Approved scope' }));
  data(await ctx.collaboration.closeDocumentReview({ reviewCode: review.review_code, principalCode: ctx.users.admin.code, conclusion: 'passed' }));
  const decided = data(await ctx.collaboration.getTopic(topic.topic_code, ctx.users.author.code));
  assert.equal(decided.current_decision.content, 'Approved scope');
  assert.equal(decided.status, 'decided');
  const approved = data(await ctx.collaboration.getDocumentReview(review.review_code, ctx.users.author.code));
  assert.equal(approved.status, 'closed');
  assert.equal(approved.conclusion, 'passed');
  assert.equal(approved.votes.length, 2);
  // Feedback remains available after a decision so Members can request reconsideration.
  data(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: ctx.inherited.code, entryType: 'feedback', content: 'Please revisit the scope' }));
  assert.equal(data(await ctx.collaboration.getTopic(topic.topic_code, ctx.inherited.code)).status, 'reopened');
  data(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: ctx.users.owner.code, entryType: 'decision', content: 'Revised scope' }));
});

test('archived projects retain document history while disabling author, Admin and discussion mutations', async () => {
  const ctx = await setup();
  const material = await createMaterials(ctx);
  const topic = data(await ctx.collaboration.createTopic({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, title: 'Topic' }));
  data(await ctx.collaboration.addTopicEntry({ topicCode: topic.topic_code, principalCode: ctx.users.author.code, entryType: 'comment', content: 'Comment' }));
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  for (const principal of [ctx.users.author, ctx.users.admin]) {
    for (const result of await Promise.all(reviseMaterials(ctx, material, principal.code))) denied(result);
    const library = data(await ctx.docs.listLibrary({ projectCode: ctx.project.code, principalCode: principal.code }));
    assert.equal(library.can_create, false);
    assert.ok(library.documents.every(document => !document.can_edit && !document.source_can_edit));
    const detail = data(await ctx.collaboration.getTopic(topic.topic_code, principal.code));
    assert.equal(detail.can_manage, false);
    assert.equal(detail.can_decide, false);
    assert.equal(detail.entries[0].can_withdraw, false);
  }
  assert.equal(data(await ctx.architecture.getDocument(material.architecture.document_code, ctx.users.admin.code)).revisions.length, 1);
});

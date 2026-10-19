import { schema } from '@team-synergy/persistence';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequirementCollaborationUseCases,
  createRequirementDocumentUseCases,
} from '../dist/index.js';
import { seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-DISCOVERY',
    teamName: 'Discovery Team',
    projectLegacyCode: 'PROJECT-DISCOVERY',
    projectName: 'discovery',
    users: [
      { key: 'author', legacyCode: 'discovery-author', account: 'discovery-author', displayName: 'Author', teamRole: 'member', projectRole: 'member' },
      { key: 'owner', legacyCode: 'discovery-owner', account: 'discovery-owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    ],
  });

  // Module administration is separate from authoring documents.
  await db.insert(schema.projectModules).values(["GENERAL"].map(name => ({ project_id: seeded.project.id, name, status: 'active', created_at: 't0', updated_at: 't0' })));  return { db, ...seeded };
}

test('想法可汇聚为议题，反馈重新打开议题，新决策保留替代关系', async () => {
  const ctx = await seededDb();
  const uc = createRequirementCollaborationUseCases(ctx.db);
  const idea = await uc.createIdea({
    projectCode: ctx.project.code,
    principalCode: ctx.users.author.code,
    title: 'Agent 领取任务时需要完整上下文',
    detail: '任务卡片摘要不足以支撑独立执行。',
    source: '开发复盘',
  });
  assert.equal(idea.ok, true, JSON.stringify(idea));
  const topic = await uc.createTopic({
    projectCode: ctx.project.code,
    principalCode: ctx.users.author.code,
    title: '任务执行上下文如何交付',
    problemStatement: 'Agent 领取任务后信息不完整。',
    ideaCodes: [idea.data.idea_code],
  });
  assert.equal(topic.ok, true, JSON.stringify(topic));
  const first = await uc.addTopicEntry({
    topicCode: topic.data.topic_code,
    principalCode: ctx.users.owner.code,
    entryType: 'decision',
    content: '任务携带需求与设计的固定版本引用。',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const feedback = await uc.addTopicEntry({
    topicCode: topic.data.topic_code,
    principalCode: ctx.users.owner.code,
    entryType: 'feedback',
    content: '缺陷修复任务还需要缺陷上下文。',
    sourceEntityType: 'defect',
    images: [{ fileName: 'defect.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  assert.equal(feedback.ok, true, JSON.stringify(feedback));
  assert.equal(feedback.data.images.length, 1);
  assert.equal(feedback.data.images[0].file_name, 'defect.png');
  const revised = await uc.addTopicEntry({
    topicCode: topic.data.topic_code,
    principalCode: ctx.users.owner.code,
    entryType: 'decision',
    content: '任务按来源固定需求、设计或缺陷上下文。',
    supersedesEntryCode: first.data.entry_code,
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const detail = await uc.getTopic(topic.data.topic_code, ctx.users.author.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.data.status, 'decided');
  assert.equal(detail.data.ideas.length, 1);
  assert.deepEqual(detail.data.entries.map((entry) => entry.entry_type), ['decision', 'feedback', 'decision']);
  assert.equal(detail.data.entries[0].supersedes_entry_code, first.data.entry_code);
  assert.equal(detail.data.entries[1].images[0].data_url, 'data:image/png;base64,iVBORw0KGgo=');
});

test('议题图片拒绝不安全类型和超额数量', async () => {
  const ctx = await seededDb();
  const uc = createRequirementCollaborationUseCases(ctx.db);
  const topic = await uc.createTopic({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, title: '图片约束' });
  assert.equal(topic.ok, true, JSON.stringify(topic));
  const unsafe = await uc.addTopicEntry({
    topicCode: topic.data.topic_code,
    principalCode: ctx.users.author.code,
    entryType: 'comment',
    content: '不允许 SVG',
    images: [{ fileName: 'unsafe.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }],
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.code, 'requirement_topic_image_type_invalid');
  const tooMany = await uc.addTopicEntry({
    topicCode: topic.data.topic_code,
    principalCode: ctx.users.author.code,
    entryType: 'comment',
    content: '图片过多',
    images: Array.from({ length: 5 }, (_, index) => ({ fileName: `${index}.png`, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })),
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error.code, 'requirement_topic_images_too_many');
});

test('非决策记录由作者或 Owner 软撤回，正文与图片脱敏且决策不可撤回', async () => {
  const ctx = await seededDb();
  const uc = createRequirementCollaborationUseCases(ctx.db);
  const topic = await uc.createTopic({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, title: '撤回规则' });
  assert.equal(topic.ok, true, JSON.stringify(topic));
  const decision = await uc.addTopicEntry({ topicCode: topic.data.topic_code, principalCode: ctx.users.owner.code, entryType: 'decision', content: '先采用方案 A。' });
  assert.equal(decision.ok, true, JSON.stringify(decision));
  const feedback = await uc.addTopicEntry({
    topicCode: topic.data.topic_code,
    principalCode: ctx.users.author.code,
    entryType: 'feedback',
    content: '这条反馈误发。',
    images: [{ fileName: 'mistake.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  });
  assert.equal(feedback.ok, true, JSON.stringify(feedback));
  const reopened = await uc.getTopic(topic.data.topic_code, ctx.users.owner.code);
  assert.equal(reopened.data.status, 'reopened');
  const withdrawn = await uc.withdrawTopicEntry({ entryCode: feedback.data.entry_code, principalCode: ctx.users.owner.code, reason: '误发内容' });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  const detail = await uc.getTopic(topic.data.topic_code, ctx.users.author.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.data.status, 'decided');
  assert.equal(detail.data.entries[0].content, '');
  assert.deepEqual(detail.data.entries[0].images, []);
  assert.equal(detail.data.entries[0].withdrawn_by_name, 'Owner');
  assert.equal(detail.data.entries[0].withdrawal_reason, '误发内容');
  assert.equal(detail.data.entries[0].can_withdraw, false);
  const decisionWithdrawal = await uc.withdrawTopicEntry({ entryCode: decision.data.entry_code, principalCode: ctx.users.author.code });
  assert.equal(decisionWithdrawal.ok, false);
  assert.equal(decisionWithdrawal.error.code, 'requirement_topic_decision_withdraw_forbidden');
});

test('文档评审固定当前 Revision 且不限制新 Revision，项目成员可投票', async () => {
  const ctx = await seededDb();
  const documents = createRequirementDocumentUseCases(ctx.db);
  const collaboration = createRequirementCollaborationUseCases(ctx.db);
  const document = await documents.createDocument({
    projectCode: ctx.project.code,
    moduleKey: 'GENERAL',
    title: '需求发现流程',
    summary: '想法、议题、文档和需求项。',
    content: '# 需求发现流程',
    principalCode: ctx.users.author.code,
  });
  assert.equal(document.ok, true, JSON.stringify(document));
  const review = await collaboration.startDocumentReview({ documentCode: document.data.document_code, principalCode: ctx.users.author.code });
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.data.revision, 1);
  const voted = await collaboration.voteDocumentReview({ reviewCode: review.data.review_code, principalCode: ctx.users.owner.code, vote: 'changes_requested', comment: '补充反馈回路。' });
  assert.equal(voted.ok, true, JSON.stringify(voted));
  assert.equal(voted.data.votes.length, 1);
  const revised = await documents.reviseDocument({
    documentCode: document.data.document_code,
    moduleKey: 'GENERAL',
    title: '需求发现流程',
    summary: '补充反馈回路。',
    content: '# 需求发现流程\n\n开发反馈可以重新打开议题。',
    changeSummary: '补充反馈回路',
    principalCode: ctx.users.author.code,
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const reviews = await collaboration.listDocumentReviews(document.data.document_code, ctx.users.owner.code);
  assert.equal(reviews.ok, true, JSON.stringify(reviews));
  assert.equal(reviews.data[0].revision, 1);
  const nextReview = await collaboration.startDocumentReview({ documentCode: document.data.document_code, principalCode: ctx.users.author.code });
  assert.equal(nextReview.ok, true, JSON.stringify(nextReview));
  assert.equal(nextReview.data.revision, 2);
});

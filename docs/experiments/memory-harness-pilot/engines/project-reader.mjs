import assert from 'node:assert/strict';
import { withOwnedFixture, projectId, targetExperience, targetAgreement } from './owned-fixture.mjs';

// A narrow fixture backend. Production needs the full typed source ACL / effective-revision resolver.
const changeId = targetAgreement.slice('agreement:'.length);

function currentDecision({ entity, sha256, hashOf, config }) {
  const change = entity('workspace_change', changeId);
  const projection = entity('candidate', targetAgreement);
  if (change?.id !== changeId || change.projectId !== projectId || change.status !== 'confirmed') return null;
  const expectedHash = hashOf({ key: change.topic, text: change.after, kind: 'rule', scope: 'project', taskId: null });
  if (projection?.status !== 'confirmed' || projection.projectId !== projectId || projection.agreementId !== changeId
    || projection.origin !== 'agreement' || projection.agreementHash !== change.hash || projection.hash !== expectedHash
    || projection.text !== change.after || hashOf(projection.affectedTaskIds) !== hashOf(change.affectedTaskIds)) return null;
  assert.ok(Array.isArray(change.affectedTaskIds) && change.affectedTaskIds.length > 0);
  return {
    scope: 'project', state: 'confirmed', source: targetAgreement, version: change.version,
    contentHash: sha256(change.after), body: change.after, projectCode: config.projects[projectId].tspProjectCode,
    affectedTaskIds: change.affectedTaskIds, applicability: 'listed_tasks',
  };
}

function expectedGeneration(entity) {
  const generation = entity('generation', entity('project', projectId).activeGenerationId);
  assert.ok(generation?.id === 'teamsynergy-1' && generation.projectId === projectId && generation.status === 'active');
  return generation;
}

async function read(input) {
  assert.ok(input && typeof input === 'object' && Object.keys(input).every(k => ['query', 'mode'].includes(k)));
  const { query = '', mode = 'search' } = input;
  assert.ok(['search', 'decisions'].includes(mode) && typeof query === 'string' && query.length <= 1000);
  if (mode === 'search') assert.ok(query.trim().length > 0);
  return withOwnedFixture(async ctx => {
    const { entity, access, memory, vault, memoryGenerationInput, sha256 } = ctx;
    await access('bob');
    const result = { fixture: 'image-contract', projectMode: 'current_decisions', accountMode: 'not_requested', rows: [] };
    if (mode === 'decisions') {
      const row = ctx.snapshot(() => currentDecision(ctx));
      if (row) result.rows.push(row);
      return result;
    }

    const generation = expectedGeneration(entity);
    const [wiki, personal] = await Promise.all([
      memory.queryProject({ projectId, externalId: generation.externalId, query, ...memoryGenerationInput(generation) }),
      vault.recall({ accountId: 'bob', query }),
    ]);
    await access('bob');
    return ctx.snapshot(() => {
      assert.equal(expectedGeneration(entity).manifestHash, generation.manifestHash);
      const project = currentDecision(ctx);
      const indexed = generation.items.find(item => item.id === targetAgreement);
      const publicHit = wiki.some(hit => hit.knowledgeIds.includes(targetAgreement));
      const current = entity('candidate', targetAgreement);
      if (publicHit && project && indexed && indexed.agreementHash === current.agreementHash && indexed.hash === current.hash
        && sha256(indexed.text) === project.contentHash) result.rows.push(project);
      result.projectMode = result.rows.length ? 'engine' : 'no_match';

      const hit = personal.find(item => item.experienceId === targetExperience);
      const approved = entity('experience', targetExperience);
      if (hit && approved?.accountId === 'bob' && approved.id === targetExperience && approved.status === 'approved'
        && approved.uri === hit.uri && approved.hash === hit.hash && approved.hash === sha256(approved.text)) {
        result.rows.push({ scope: 'self', state: 'experience', source: targetExperience, version: approved.hash, contentHash: approved.hash, body: approved.text });
        result.accountMode = 'engine';
      } else result.accountMode = 'no_match';
      return result;
    });
  }, { engines: mode === 'search' });
}

export async function readProjectFixture(input) {
  try { return await read(input); }
  catch { throw new Error('Project fixture unavailable, scope rejected or source changed.'); }
}

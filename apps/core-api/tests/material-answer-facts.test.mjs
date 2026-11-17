import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materialAnswerFacts } from './native-project-material-index.mjs';
test('material facts accept an exact quoted line but never another revision, marker or implementation claim', () => {
  const corpus = [{ kind: 'project', sourceCitation: 'immutable-revision', marker: 'random-unique-token' }];
  const answer = { documentStatus: 'active/documented（当前修订）', decisionEvidence: 'absent', implementationEvidence: 'absent',
    materials: [{ kind: 'project', source: 'immutable-revision', marker: '文末验收标记：random-unique-token' }] };
  assert.equal(materialAnswerFacts(answer, corpus), true);
  assert.equal(materialAnswerFacts({ ...answer, documentStatus: '当前修订 revision 1、state=documented；仅属资料陈述' }, corpus), true);
  for (const invalid of [
    { ...answer, documentStatus: 'confirmed' }, { ...answer, documentStatus: 'documented implemented' },
    { ...answer, documentStatus: 'not documented' }, { ...answer, documentStatus: 'undocumented' },
    { ...answer, implementationEvidence: 'present' }, { ...answer, decisionEvidence: 'present' },
    { ...answer, materials: [{ ...answer.materials[0], source: 'mutable-object-code' }] },
    { ...answer, materials: [{ ...answer.materials[0], marker: 'prefix random-unique-token invented claim' }] },
  ]) assert.equal(materialAnswerFacts(invalid, corpus), false);
});

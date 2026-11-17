import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectMaterialGlobInput, ProjectMaterialGrepInput, ProjectMaterialReadInput } from '../dist/project-materials.js';

const objectCode = '00000000000000000001';
test('material contracts reject ambiguous versions, unsafe paths and unbounded search', () => {
  assert.equal(ProjectMaterialReadInput.safeParse({ sourceKind: 'project', objectCode, revision: 2, limit: 100 }).success, true);
  assert.equal(ProjectMaterialReadInput.safeParse({ sourceCitation: objectCode }).success, true);
  assert.equal(ProjectMaterialReadInput.safeParse({ sourceCitation: objectCode, revision: 2 }).success, false);
  assert.equal(ProjectMaterialReadInput.safeParse({ path: '../private' }).success, false);
  assert.equal(ProjectMaterialReadInput.safeParse({ sourceKind: 'project', objectCode, offset: 1, startLine: 2 }).success, false);
  assert.equal(ProjectMaterialGlobInput.safeParse({ pattern: '**/*.md' }).success, true);
  assert.equal(ProjectMaterialGlobInput.safeParse({ pattern: '../**' }).success, false);
  assert.equal(ProjectMaterialGrepInput.safeParse({ pattern: '退款', mode: 'literal', contextLines: 2 }).success, true);
  assert.equal(ProjectMaterialGrepInput.safeParse({ pattern: '(a+)+$', mode: 'regex', limit: 100000 }).success, false);
});

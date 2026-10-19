import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeHash, intakeTargets } from '../dist/intake-targets.js';

// This projection test needs no database; the selected rows represent the current revision join.
function selectedRows(architectures) {
  const results = [[], [], [], architectures];
  return { select() { const query = { from() { return query; }, innerJoin() { return query; }, where() { return Promise.resolve(results.shift()); } }; return query; } };
}

for (const kind of ['mermaid', 'drawio']) {
  test(`architecture intake target includes current ${kind} source and preview for review without changing its fingerprint`, async () => {
    const header = { id: 1n, code: 'ARCHITECTURE', title: 'Current architecture', summary: 'Existing diagram', current_revision: 4, project_id: 9n };
    const revision = { id: 4n, document_id: 1n, revision: 4, content_kind: kind, source_content: kind === 'mermaid' ? 'flowchart LR\nA-->B' : '<mxfile><diagram>current drawing</diagram></mxfile>', preview_svg: kind === 'mermaid' ? null : '<svg xmlns="http://www.w3.org/2000/svg"><text>Current diagram</text></svg>', notes_markdown: '' };
    const [result] = await intakeTargets(selectedRows([{ header, revision }]), 9n);
    assert.equal(result.target.kind, 'architecture');
    assert.equal(result.target.content_markdown, '');
    assert.deepEqual(result.target.diagram, { content_kind: kind, source_content: revision.source_content, preview_svg: revision.preview_svg });
    assert.equal(result.target.fingerprint, intakeHash({ header, revision }));
    const [changed] = await intakeTargets(selectedRows([{ header, revision: { ...revision, source_content: `${revision.source_content}\nChanged` } }]), 9n);
    assert.notEqual(changed.target.fingerprint, result.target.fingerprint);
  });
}

test('image architecture keeps its existing optional projection without mislabeling the source as Mermaid', async () => {
  const header = { id: 1n, code: 'IMAGE', title: 'Image', summary: '' };
  const revision = { content_kind: 'image', source_content: 'data:image/png;base64,AA==', preview_svg: null, notes_markdown: 'Notes' };
  const [result] = await intakeTargets(selectedRows([{ header, revision }]), 9n);
  assert.equal(result.target.diagram, undefined);
  assert.equal(result.target.content_markdown, 'Notes');
});

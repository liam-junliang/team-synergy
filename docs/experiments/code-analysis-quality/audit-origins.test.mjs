import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditOrigins } from './audit-origins.mjs';

const cn = 'workbuddy/deepseek-v4.1-flash', sg = 'workbuddy-sg/deepseek-v4.1-flash';
function fixture() {
  const provenance = { requested_model: sg, origins: [{ kind: 'cache', requested_model: cn, response_model: cn, uses: 476 }, { kind: 'live', requested_model: sg, response_model: 'deepseek-v4.1-flash', uses: 12 }], mixed_origins: true };
  return { artifact: { semantic_author: { kind: 'agent', model: sg, provenance: structuredClone(provenance) } }, quality: { model_provenance: structuredClone(provenance) }, execution: { model_provenance: structuredClone(provenance), response_models: [cn, 'deepseek-v4.1-flash'] } };
}
test('mixed declarations can agree without pretending they prove actual execution or identical weights', () => {
  const f = fixture(); f.quality.model_provenance.origins.reverse();
  f.execution.model_provenance.origins = f.execution.model_provenance.origins.map(origin => ({ uses: origin.uses, response_model: origin.response_model, requested_model: origin.requested_model, kind: origin.kind }));
  const result = auditOrigins(f);
  assert.equal(result.declaration_status, 'pass'); assert.equal(result.execution_evidence_status, 'unverified');
  assert.deepEqual(result.declared_uses, { cache: 476, live: 12 });
  assert(result.limitations.some(value => value.includes('identical weights')));
});
test('historical cache route identity and actual response set cannot be silently rewritten to current SG', () => {
  const f = fixture(); f.quality.model_provenance.origins[0].requested_model = sg;
  assert.equal(auditOrigins(f).declaration_status, 'fail');
  const missingResponse = fixture(); missingResponse.execution.response_models = ['deepseek-v4.1-flash'];
  assert(auditOrigins(missingResponse).issues.includes('execution:response_models_do_not_equal_actual_declared_response_set'));
});
test('positive exact uses, known kinds and complete provenance shape remain strict', () => {
  for (const mutate of [
    f => { f.artifact.semantic_author.provenance.origins[0].uses = 0; },
    f => { f.artifact.semantic_author.provenance.origins[0].uses = 1.5; },
    f => { f.artifact.semantic_author.provenance.origins[0].kind = 'inferred'; },
    f => { f.artifact.semantic_author.provenance.origins[0].unexpected = true; },
    f => { f.artifact.semantic_author.provenance.origins.push({ ...f.artifact.semantic_author.provenance.origins[0] }); },
    f => { f.artifact.semantic_author.model = cn; },
    f => { f.artifact.semantic_author.provenance.origins[0].requested_model = 'route\nmodel'; },
    f => { f.execution.model_provenance.origins[0].uses++; },
  ]) { const f = fixture(); mutate(f); assert.equal(auditOrigins(f).declaration_status, 'fail'); }
});
test('mixed means distinct requested routes, not distinct response aliases or access kinds', () => {
  const f = fixture();
  const p = { requested_model: sg, origins: [{ kind: 'cache', requested_model: sg, response_model: sg, uses: 3 }, { kind: 'live', requested_model: sg, response_model: 'deepseek-v4.1-flash', uses: 2 }], mixed_origins: false };
  f.artifact.semantic_author.provenance = structuredClone(p); f.quality.model_provenance = structuredClone(p); f.execution.model_provenance = structuredClone(p); f.execution.response_models = [sg, 'deepseek-v4.1-flash'];
  assert.equal(auditOrigins(f).declaration_status, 'pass');
  f.artifact.semantic_author.provenance.mixed_origins = true;
  assert(auditOrigins(f).issues.includes('artifact:mixed_flag_mismatch'));
});
test('missing evidence stays unverified, and a same-suffix unrelated route is not the short response alias', () => {
  assert.equal(auditOrigins({}).declaration_status, 'unverified');
  const f = fixture(); f.artifact.semantic_author.provenance.origins[0].response_model = 'unrelated/deepseek-v4.1-flash';
  assert.equal(auditOrigins(f).declaration_status, 'fail');
});

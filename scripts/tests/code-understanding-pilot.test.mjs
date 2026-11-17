import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessReuse, auditBinding, buildManifest, canonicalJson, contentHash,
  dependencyDigest, diffManifests, factFingerprint, rebindEvidence,
} from '../code-understanding-pilot/facts.mjs';

const repositories = [{ repository: 'api', commit: 'api-1', snapshot: 'snap-1' },
  { repository: 'agent', commit: 'agent-1', snapshot: 'agent-snap-1' }];
const sources = [
  { repository: 'api', path: 'guard.ts', content: 'export const allowed = epoch > 0;\n' },
  { repository: 'api', path: 'routes.ts', content: "post('/submit', tasks.submit);\n" },
  { repository: 'api', path: 'unrelated.ts', content: 'unrelated\n' },
  { repository: 'agent', path: 'guard.ts', content: 'agent guard\n' },
];
const options = { analysisProtocol: 'pilot-v1', model: { provider: 'test', name: 'fixed' } };
const facts = [
  { id: 'submit', repository: 'api', subject: 'task', actor: 'member', action: 'submit', object: 'result',
    preconditions: ['epoch > 0'], outcomes: ['submitted'], exceptions: ['stale epoch'],
    dependencies: [{ kind: 'guard', repository: 'api', path: 'guard.ts' },
      { kind: 'route', repository: 'api', path: 'routes.ts' }] },
  { id: 'handover', repository: 'agent', subject: 'handover', action: 'accept',
    dependencies: [{ kind: 'guard', repository: 'api', path: 'guard.ts' }] },
  { id: 'local', repository: 'agent', subject: 'agent', action: 'observe',
    dependencies: [{ kind: 'source', repository: 'agent', path: 'guard.ts' }] },
];
const makeManifest = (overrides = {}) => buildManifest({ repositories, sources, facts,
  contracts: [{ id: 'task-agent', factIds: ['submit', 'handover'] }],
  summaries: [{ id: 'agent-module', factIds: ['local'], contractIds: ['task-agent'] }],
  ...options, ...overrides });
const binding = (overrides = {}) => ({ repository: 'api', commit: 'api-1', snapshot: 'snap-1',
  path: 'guard.ts', contentHash: contentHash(sources[0].content), startLine: 1, endLine: 1,
  quote: sources[0].content.trimEnd(), ...overrides });
const changedSources = (path, content) => sources.map(source =>
  source.repository === 'api' && source.path === path ? { ...source, content } : source);

test('canonical semantics ignore presentation and key order but retain all conditions and identities', () => {
  assert.equal(canonicalJson({ b: 1, a: { z: 2, y: 3 } }), '{"a":{"y":3,"z":2},"b":1}');
  const fact = facts[0];
  const key = factFingerprint(fact, options);
  assert.equal(key, factFingerprint({ ...fact, displayText: 'New prose', presentation: { color: 'blue' },
    parentParagraph: 'new context', startLine: 900, endLine: 999 }, options));
  for (const change of [{ preconditions: ['epoch >= 0'] }, { outcomes: ['guaranteed success'] },
    { exceptions: [] }, { actor: 'admin' }, { repository: 'agent' }]) {
    assert.notEqual(key, factFingerprint({ ...fact, ...change }, options));
  }
  assert.notEqual(key, factFingerprint(fact, { ...options, analysisProtocol: 'pilot-v2' }));
  assert.notEqual(key, factFingerprint(fact, { ...options, model: 'other' }));
});

test('presentation-only updates reuse the verdict after current source audit', () => {
  const previous = makeManifest();
  const current = makeManifest({ facts: facts.map(fact => ({ ...fact, displayText: 'Reworded' })) });
  assert.deepEqual(diffManifests(previous, current).invalidFacts, []);
  assert.equal(assessReuse(previous.facts.submit, current.facts.submit,
    { previousRepositories: repositories, repositories, sources, bindings: [binding()] }).reusable, true);
  const changed = makeManifest({ facts: facts.map(fact => fact.id === 'submit'
    ? { ...fact, preconditions: ['epoch >= 0'] } : fact) });
  assert.deepEqual(diffManifests(previous, changed).invalidFacts, ['submit']);
});

test('full guard content changes invalidate across modules with unchanged call topology', () => {
  const previous = makeManifest();
  const current = makeManifest({ sources: changedSources('guard.ts', 'export const allowed = epoch >= 0;\n') });
  const change = diffManifests(previous, current);
  assert.deepEqual(change.invalidFacts, ['handover', 'submit']);
  assert.deepEqual(change.invalidContracts, ['task-agent']);
  assert.deepEqual(change.invalidSummaries, ['agent-module']);
  assert.deepEqual(change.changedDependencies, [{ repository: 'api', path: 'guard.ts' }]);
  assert.equal(previous.facts.local.fingerprint, current.facts.local.fingerprint);
});

test('explicit route dependencies detect bindings absent from native caller edges', () => {
  const current = makeManifest({ sources: changedSources('routes.ts', "post('/submit-v2', tasks.verify);\n") });
  const change = diffManifests(makeManifest(), current);
  assert.deepEqual(change.invalidFacts, ['submit']);
  assert.deepEqual(change.invalidContracts, ['task-agent']);
});

test('unrelated source changes leave scoped facts reusable', () => {
  const current = makeManifest({ sources: changedSources('unrelated.ts', 'completely changed\n') });
  assert.deepEqual(diffManifests(makeManifest(), current).invalidFacts, []);
  assert.deepEqual(diffManifests(makeManifest(), current).invalidSummaries, []);
});

test('source bindings require correct repository, vector, full hash, range and quote', () => {
  assert.equal(auditBinding(binding(), { repositories, sources }).status, 'valid');
  for (const invalid of [{ repository: 'agent' }, { commit: 'api-2' }, { snapshot: 'other' },
    { contentHash: 'wrong' }, { startLine: 0 }, { endLine: 8 }, { quote: 'invented' }, { path: '../guard.ts' }]) {
    assert.equal(auditBinding(binding(invalid), { repositories, sources }).status, 'unknown');
  }
});

test('line shifts rebind only an exact unique quote and never erase content invalidation', () => {
  const shifted = changedSources('guard.ts', `// moved\n${sources[0].content}`);
  const vector = repositories.map(repo => repo.repository === 'api'
    ? { ...repo, commit: 'api-2', snapshot: 'snap-2' } : repo);
  const rebound = rebindEvidence(binding(), { repositories: vector, sources: shifted });
  assert.equal(rebound.status, 'rebound');
  assert.equal(rebound.binding.startLine, 2);
  assert.equal(rebound.binding.endLine, 2);
  assert.equal(auditBinding(rebound.binding, { repositories: vector, sources: shifted }).status, 'valid');
  const previous = makeManifest();
  const current = makeManifest({ repositories: vector, sources: shifted });
  assert.equal(assessReuse(previous.facts.submit, current.facts.submit,
    { previousRepositories: repositories, repositories: vector, sources: shifted,
      bindings: [rebound.binding] }).reusable, false);
});

test('ambiguous, absent and wrong-repository quote rebinding stays unknown', () => {
  for (const content of [`${sources[0].content}${sources[0].content}`, 'same line number, different code\n']) {
    assert.equal(rebindEvidence(binding(),
      { repositories, sources: changedSources('guard.ts', content) }).status, 'unknown');
  }
  assert.equal(rebindEvidence(binding({ repository: 'agent' }), { repositories, sources }).status, 'unknown');
});

test('identical bytes under a new repo commit require fresh bindings before verdict reuse', () => {
  const vector = repositories.map(repo => repo.repository === 'api'
    ? { ...repo, commit: 'api-2', snapshot: 'snap-2' } : repo);
  const previous = makeManifest();
  const current = makeManifest({ repositories: vector });
  const context = { previousRepositories: repositories, repositories: vector, sources, bindings: [binding()] };
  assert.equal(assessReuse(previous.facts.submit, current.facts.submit, context).reusable, false);
  assert.equal(assessReuse(previous.facts.submit, current.facts.submit, { ...context, bindings: [] }).reusable, false);
  const rebound = rebindEvidence(binding(), { repositories: vector, sources });
  assert.equal(assessReuse(previous.facts.submit, current.facts.submit,
    { ...context, bindings: [rebound.binding] }).reusable, true);
  assert.equal(assessReuse(previous.facts.submit, current.facts.local,
    { ...context, bindings: [rebound.binding] }).reusable, false);
});

test('unresolved dependencies cannot promote verified reuse across any snapshot vector change', () => {
  const unresolvedFacts = [{ ...facts[0], dependencies: [{ kind: 'caller', repository: 'api',
    path: 'dynamic.ts', unresolved: true }] }];
  const previous = makeManifest({ facts: unresolvedFacts, contracts: [], summaries: [] });
  const vector = repositories.map(repo => repo.repository === 'agent' ? { ...repo, commit: 'agent-2' } : repo);
  const current = makeManifest({ repositories: vector, facts: unresolvedFacts, contracts: [], summaries: [] });
  assert.equal(previous.facts.submit.resolved, false);
  assert.equal(assessReuse(previous.facts.submit, current.facts.submit,
    { previousRepositories: repositories, repositories: vector, sources, bindings: [binding()] }).reusable, false);
  assert.equal(dependencyDigest([{ kind: 'invented', repository: 'api', path: 'guard.ts' }], sources).resolved, false);
  assert.equal(dependencyDigest([{ kind: 'source', repository: 'api', path: 'missing.ts' }], sources).resolved, false);
});

test('every explicit dependency kind uses full content and manifest vectors own their identity', () => {
  for (const kind of ['source', 'guard', 'caller', 'route', 'policy', 'config', 'schema', 'background']) {
    const dependencies = [{ kind, repository: 'api', path: 'guard.ts' }];
    assert.notEqual(dependencyDigest(dependencies, sources).digest,
      dependencyDigest(dependencies, changedSources('guard.ts', sources[0].content + '// changed\n')).digest);
  }
  const vector = repositories.map(repository => ({ ...repository }));
  const manifest = makeManifest({ repositories: vector });
  vector[0].commit = 'mutated';
  assert.equal(manifest.repositories[0].commit, 'api-1');
  const rogue = makeManifest({ facts: [{ ...facts[0], dependencies: [{ kind: 'source',
    repository: 'unlisted', path: 'guard.ts' }] }], sources: [...sources,
    { repository: 'unlisted', path: 'guard.ts', content: 'known bytes without known commit' }] });
  assert.equal(rogue.facts.submit.resolved, false);
  assert.throws(() => makeManifest({ repositories: [{ repository: 'api', commit: 'global-only' }] }), /snapshot/);
});

test('a current manifest cannot bypass missing source content or silently omit previous evidence', () => {
  const manifest = makeManifest({ facts: [{ ...facts[0], evidence: [binding(),
    binding({ path: 'routes.ts', contentHash: contentHash(sources[1].content), quote: sources[1].content.trimEnd() })] }] });
  const context = { previousRepositories: repositories, repositories, sources, bindings: [binding()] };
  assert.equal(assessReuse(manifest.facts.submit, manifest.facts.submit, context).reason,
    'previous-evidence-not-rebound');
  const withoutGuard = sources.filter(source => source.path !== 'guard.ts');
  assert.equal(assessReuse(manifest.facts.submit, manifest.facts.submit,
    { ...context, sources: withoutGuard }).reason, 'current-dependency-content-mismatch');
});

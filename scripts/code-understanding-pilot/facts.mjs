// Experimental, in-memory pilot only. Production semantic caches are intentionally independent.
import { createHash } from 'node:crypto';

const dependencyKinds = new Set(['source', 'guard', 'caller', 'route', 'policy', 'config', 'schema', 'background']);
const semanticFields = ['subject', 'actor', 'action', 'object', 'preconditions', 'outcomes', 'exceptions',
  'observationType', 'risk'];
const key = value => canonicalJson([value.repository, value.path]);
const unknown = reason => ({ status: 'unknown', reason });
const validPath = path => typeof path === 'string' && path.length > 0
  && !/^[\\/]|^[a-z]:|\\/iu.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().filter(name => value[name] !== undefined)
      .map(name => JSON.stringify(name) + ':' + canonicalJson(value[name])).join(',') + '}';
  }
  throw new TypeError('Canonical values must be finite JSON values');
}

export function contentHash(content) {
  if (typeof content !== 'string') throw new TypeError('Source content must be a string');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const hash = value => contentHash(canonicalJson(value));
const nonempty = value => typeof value === 'string' && value.length > 0;
function sourceFor(reference, sources) {
  if (!nonempty(reference.repository) || !validPath(reference.path)) return undefined;
  const matches = sources.filter(source => key(source) === key(reference));
  return matches.length === 1 && typeof matches[0].content === 'string' ? matches[0] : undefined;
}
function repositoryFor(repository, repositories) {
  const matches = repositories.filter(item => item.repository === repository);
  return matches.length === 1 && nonempty(matches[0].commit) && nonempty(matches[0].snapshot)
    ? matches[0] : undefined;
}
const vectorFingerprint = repositories => hash([...repositories].sort((a, b) =>
  canonicalJson(a).localeCompare(canonicalJson(b))));

export function factFingerprint(fact, { analysisProtocol = fact.analysisProtocol, model = fact.model } = {}) {
  if (!nonempty(fact.repository) || !analysisProtocol || !model) {
    throw new TypeError('Fact repository, analysisProtocol and model identity are required');
  }
  const semantics = Object.fromEntries(semanticFields.map(name => [name, fact[name] ?? null]));
  return hash({ repository: fact.repository, ...semantics, analysisProtocol, model });
}

export function dependencyDigest(dependencies, sources) {
  const entries = dependencies.map(dependency => {
    const source = sourceFor(dependency, sources);
    const resolved = dependencyKinds.has(dependency.kind) && !dependency.unresolved && Boolean(source);
    return { kind: dependency.kind ?? null, repository: dependency.repository ?? null,
      path: dependency.path ?? null, contentHash: resolved ? contentHash(source.content) : null, resolved };
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return { digest: hash(entries), dependencies: entries, resolved: entries.every(entry => entry.resolved) };
}

function indexById(items, transform) {
  if (items.some(item => !nonempty(item.id)) || new Set(items.map(item => item.id)).size !== items.length) {
    throw new TypeError('Manifest IDs must be nonempty and unique');
  }
  return Object.fromEntries(items.map(item => [item.id, transform(item)]));
}

export function buildManifest({ repositories, sources, facts, contracts = [], summaries = [], analysisProtocol, model }) {
  if (new Set(repositories.map(repo => repo.repository)).size !== repositories.length
    || repositories.some(repo => !nonempty(repo.repository) || !repositoryFor(repo.repository, repositories))) {
    throw new TypeError('Each repository needs its own unique commit and snapshot');
  }
  const factIndex = indexById(facts, fact => {
    if (!repositoryFor(fact.repository, repositories)) throw new TypeError('Fact repository is absent from vector');
    const dependency = dependencyDigest((fact.dependencies ?? []).map(item => ({ ...item,
      unresolved: item.unresolved || !repositoryFor(item.repository, repositories) })), sources);
    const semanticFingerprint = factFingerprint(fact, { analysisProtocol, model });
    return { id: fact.id, repository: fact.repository, semanticFingerprint, dependencyDigest: dependency.digest,
      fingerprint: hash([semanticFingerprint, dependency.digest]), dependencies: dependency.dependencies,
      resolved: dependency.resolved, evidence: (fact.evidence ?? []).map(binding => ({ ...binding })) };
  });
  const references = (ids, index) => [...ids].sort().map(id => [id, index[id]?.fingerprint ?? null]);
  const contractIndex = indexById(contracts, contract => {
    const { id, factIds = [], displayText: _displayText, presentation: _presentation, ...semantics } = contract;
    return { id, factIds: [...factIds], fingerprint: hash([semantics, references(factIds, factIndex)]) };
  });
  const summaryIndex = indexById(summaries, summary => {
    const { id, factIds = [], contractIds = [] } = summary;
    return { id, factIds: [...factIds], contractIds: [...contractIds],
      fingerprint: hash([references(factIds, factIndex), references(contractIds, contractIndex)]) };
  });
  return { repositories: repositories.map(repository => ({ ...repository })),
    facts: factIndex, contracts: contractIndex, summaries: summaryIndex };
}

export function diffManifests(previous, current) {
  const vectorChanged = vectorFingerprint(previous.repositories) !== vectorFingerprint(current.repositories);
  const changed = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(id => before[id]?.fingerprint !== after[id]?.fingerprint).sort();
  const invalidFacts = [...new Set([...changed(previous.facts, current.facts), ...Object.values(current.facts)
    .filter(fact => vectorChanged && !fact.resolved).map(fact => fact.id)])].sort();
  const invalidContracts = [...new Set([...changed(previous.contracts, current.contracts),
    ...Object.values(current.contracts).filter(contract => contract.factIds.some(id => invalidFacts.includes(id)))
      .map(contract => contract.id)])].sort();
  const invalidSummaries = [...new Set([...changed(previous.summaries, current.summaries),
    ...Object.values(current.summaries).filter(summary => summary.factIds.some(id => invalidFacts.includes(id))
      || summary.contractIds.some(id => invalidContracts.includes(id))).map(summary => summary.id)])].sort();
  const dependencies = manifest => {
    const grouped = new Map();
    for (const dependency of Object.values(manifest.facts).flatMap(fact => fact.dependencies)) {
      const id = key(dependency), values = grouped.get(id) ?? new Set();
      values.add(dependency.contentHash); grouped.set(id, values);
    }
    return new Map([...grouped].map(([id, values]) => [id, hash([...values].sort())]));
  };
  const before = dependencies(previous), after = dependencies(current);
  const changedDependencies = [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(id => before.get(id) !== after.get(id)).map(id => {
      const [repository, path] = JSON.parse(id); return { repository, path };
    });
  return { invalidFacts, invalidContracts, invalidSummaries, changedDependencies };
}

export function auditBinding(binding, { repositories, sources }) {
  const repository = repositoryFor(binding.repository, repositories);
  if (!repository || repository.snapshot !== binding.snapshot || repository.commit !== binding.commit) {
    return unknown('repository-or-snapshot-mismatch');
  }
  const source = sourceFor(binding, sources);
  if (!source) return unknown('source-missing-or-ambiguous');
  if (contentHash(source.content) !== binding.contentHash) return unknown('full-content-hash-mismatch');
  const lines = source.content.split('\n');
  if (!Number.isInteger(binding.startLine) || !Number.isInteger(binding.endLine) || binding.startLine < 1
    || binding.endLine < binding.startLine || binding.endLine > lines.length) return unknown('invalid-line-range');
  if (!nonempty(binding.quote)
    || !lines.slice(binding.startLine - 1, binding.endLine).join('\n').includes(binding.quote)) {
    return unknown('quote-does-not-match-range');
  }
  return { status: 'valid', reason: 'current-source-audited' };
}

export function rebindEvidence(binding, { repositories, sources }) {
  const repository = repositoryFor(binding.repository, repositories), source = sourceFor(binding, sources);
  if (!repository || !source || !nonempty(binding.quote)) return unknown('source-or-quote-missing');
  const offset = source.content.indexOf(binding.quote);
  if (offset < 0) return unknown('quote-absent');
  if (source.content.indexOf(binding.quote, offset + 1) >= 0) return unknown('quote-ambiguous');
  const rebound = { ...binding, commit: repository.commit, snapshot: repository.snapshot,
    contentHash: contentHash(source.content), startLine: source.content.slice(0, offset).split('\n').length,
    endLine: source.content.slice(0, offset + binding.quote.length - 1).split('\n').length };
  const audit = auditBinding(rebound, { repositories, sources });
  return audit.status === 'valid' ? { status: 'rebound', binding: rebound, reason: 'unique-exact-quote' } : audit;
}

export function assessReuse(previous, current, { previousRepositories, repositories, bindings = current.evidence, sources }) {
  const reject = reason => ({ reusable: false, status: 'unknown', reason, audits: [] });
  if (!repositoryFor(previous.repository, previousRepositories) || !repositoryFor(current.repository, repositories)) {
    return reject('fact-repository-absent-from-vector');
  }
  if (previous.repository !== current.repository || previous.fingerprint !== current.fingerprint) {
    return reject('semantic-or-dependency-change');
  }
  if ((!previous.resolved || !current.resolved)
    && vectorFingerprint(previousRepositories) !== vectorFingerprint(repositories)) return reject('unresolved-dependency');
  if (current.dependencies.some(dependency => dependency.resolved && (!sourceFor(dependency, sources)
    || contentHash(sourceFor(dependency, sources).content) !== dependency.contentHash))) {
    return reject('current-dependency-content-mismatch');
  }
  if (!bindings?.length) return reject('current-bindings-required');
  if (previous.evidence.some(expected => !bindings.some(binding => key(expected) === key(binding)
    && expected.quote === binding.quote))) return reject('previous-evidence-not-rebound');
  const audits = bindings.map(binding => current.dependencies.some(dependency => key(dependency) === key(binding))
    ? auditBinding(binding, { repositories, sources }) : unknown('binding-outside-fact-dependencies'));
  const reusable = audits.every(audit => audit.status === 'valid');
  return { reusable, status: reusable ? 'reusable' : 'unknown', reason: reusable
    ? 'same-semantics-and-dependencies-current-bindings-audited' : 'binding-audit-failed', audits };
}

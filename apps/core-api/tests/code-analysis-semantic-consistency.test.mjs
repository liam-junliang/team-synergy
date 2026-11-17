import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcileSemanticBriefs } from '../dist/code-analysis-semantic-consistency.js';
import { createSemanticModelClient } from '../dist/code-analysis-semantic-model.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-callee-reconcile-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-callee-reconcile-')); rmSync(root, { recursive: true, force: true }); });
  const sourceDirectory = path.join(root, 'source'), runDirectory = path.join(root, 'run'); mkdirSync(sourceDirectory); mkdirSync(runDirectory);
  const contents = { 'caller.ts': 'import { resolveActor } from "./identity.js";\nexport function handler(context, payload) {\n  return resolveActor(context, payload);\n}\n', 'identity.ts': 'export function resolveActor(context, payload) {\n  void payload;\n  return context.authenticatedActor;\n}\n' };
  const files = Object.entries(contents).map(([file, text]) => { writeFileSync(path.join(sourceDirectory, file), text); return { path: file, sha256: semanticDigest(Buffer.from(text)), byte_count: Buffer.byteLength(text), line_count: text.split('\n').length }; });
  const range = file => [{ path: file, line_start: 1, line_end: file === 'caller.ts' ? 4 : 4 }];
  const briefs = files.map(file => ({ path: file.path, sha256: file.sha256, input_sha256: semanticDigest(file), segment_ids: [`segment:${semanticDigest(file).slice(0, 32)}`], summary: file.path === 'caller.ts' ? 'The request identity is derived from payload by resolveActor.' : 'The identity resolver ignores payload and returns the authenticated actor from context.', responsibility: 'Resolves a request identity at the documented boundary.', behaviors: [{ description: file.path === 'caller.ts' ? 'Uses resolveActor to derive identity from payload.' : 'The payload parameter is intentionally unused; context owns authenticated identity.', evidence: range(file.path) }], state_owners: ['Authenticated identity'], user_purposes: ['Resolve authenticated request identity'], dependencies: [], evidence: range(file.path), unknowns: [] }));
  const native = { nodes: [{ id: 'cg:handler', kind: 'function', label: 'handler', path: 'caller.ts', line_start: 2, line_end: 4 }, { id: 'cg:resolver', kind: 'function', label: 'resolveActor', path: 'identity.ts', line_start: 1, line_end: 4 }], edges: [{ id: 'cg-edge:fixture', source: 'cg:handler', target: 'cg:resolver', type: 'calls' }] };
  const dependencies = [{ id: 'fixture', source: 'caller.ts', target: 'identity.ts', type: 'calls', native_ids: ['cg-edge:fixture'], count: 1, evidence: [...range('caller.ts'), ...range('identity.ts')] }];
  return { root, sourceDirectory, runDirectory, snapshot: { snapshot_id: 'a'.repeat(64), manifest_sha256: semanticDigest(files), files }, briefs, native, dependencies };
}
function modelResponse(value) { return new Response(JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })); }
function contextualResponse(request, value) {
  return modelResponse({ ...value, files: value.files.map(row => {
    const context = request.files.find(file => file.context_id === row.context_id);
    return { ...row, findings: row.findings.map(finding => {
      if ('evidence_ids' in finding) return finding;
      const { evidence, ...rest } = finding;
      return { ...rest, evidence_ids: [...new Set(evidence.map(range => context.evidence_catalog.find(entry => entry.path === range.path && entry.line_start <= range.line_start && entry.line_end >= range.line_end)?.id ?? 'E_OUTSIDE_CONTEXT'))] };
    }) };
  }) });
}
function expandEvidence(value, catalog) {
  if (Array.isArray(value)) return value.map(item => expandEvidence(item, catalog));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => key === 'evidence_ids' ? ['evidence', item.map(id => { const { id: _id, ...range } = catalog.find(entry => entry.id === id); return range; })] : [key, expandEvidence(item, catalog)]));
  return value;
}
function chineseCallerFixture(t) {
  const input = fixture(t), caller = input.briefs.find(brief => brief.path === 'caller.ts');
  caller.summary = '请求身份来自传入的数据。'; caller.responsibility = '确定当前请求的身份。';
  caller.behaviors[0].description = '从传入的数据解析当前主体。'; caller.state_owners = ['已认证主体']; caller.user_purposes = ['取得请求身份'];
  return input;
}
function findingsClient(input, decide) {
  return createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    return contextualResponse(request, { files: request.files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: decide(file), unresolved_dependencies: [] })) });
  } });
}

async function assertHostDowngrade(input, client) {
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
  assert.equal(result.audit.corrected_claims, 0); assert.equal(result.audit.applied_corrected_claims, 0);
  assert.equal(result.audit.host_downgraded_findings, 1); assert.equal(result.audit.uncertain_claims, 1);
  const finding = result.audit.checks.flatMap(check => check.findings).find(finding => finding.host_reason);
  assert.equal(finding.host_reason, 'missing_complete_callee_definition'); assert.equal(finding.status, 'uncertain'); assert.equal(finding.replacement, '');
  assert.equal(finding.original_proposal.status, 'corrected'); assert.ok(finding.original_proposal.replacement); assert.ok(finding.original_proposal.reason); assert.ok(finding.original_proposal.evidence_ids.length);
  assert.deepEqual(finding.evidence, finding.original_proposal.evidence);
  const caller = result.briefs.find(brief => brief.path === 'caller.ts'); assert.match(caller.summary, /^待确认/);
  assert.ok(caller.unknowns.some(note => note.includes('宿主未采用纠正建议')));
  assert.equal(caller.unknowns.some(note => note.includes(finding.original_proposal.reason)), false);
  return result;
}

test('caller source normalization preserves every row, claim, dependency and complete callee definition', async t => {
  const input = chineseCallerFixture(t), original = structuredClone(input.briefs);
  const caller = input.briefs.find(brief => brief.path === 'caller.ts');
  caller.behaviors[0].evidence = [{ path: caller.path, line_start: 2, line_end: 3 }, { path: caller.path, line_start: 4, line_end: 4 }];
  caller.dependencies = [{ target: 'identity.ts', type: 'calls', description: '调用解析函数取得当前主体。', status: 'observed', evidence: [{ path: caller.path, line_start: 3, line_end: 3 }] }];
  const before = structuredClone(input.briefs), requests = []; let promptBytes = 0;
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, options) => {
    const content = JSON.parse(options.body).messages[1].content, request = JSON.parse(content);
    promptBytes += Buffer.byteLength(content); requests.push(request);
    return contextualResponse(request, { files: request.files.map(file => ({ context_id: file.context_id,
      checked_claims: file.claims.map(claim => claim.id), findings: [], unresolved_dependencies: [] })) });
  } });
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
  const contexts = requests.flatMap(request => request.files), callerContexts = contexts.filter(file => file.path === caller.path);
  t.diagnostic(JSON.stringify({ planner_fixture: 'overlapping-caller-ranges', groups: requests.length, contexts: contexts.length,
    prompt_bytes: promptBytes, caller_source_ranges: callerContexts.flatMap(file => file.sources.filter(source => source.path === caller.path)).length }));
  assert.deepEqual(input.briefs, before);
  assert.notDeepEqual(original, before, 'fixture must actually add nested and overlapping source ranges');
  assert.equal(result.audit.files_checked, input.briefs.length);
  assert.equal(callerContexts.length, 1);
  const context = callerContexts[0], ownSources = context.sources.filter(source => source.path === caller.path);
  const rows = ranges => [...new Set(ranges.flatMap(range => Array.from({ length: range.line_end - range.line_start + 1 }, (_, index) => `${range.path}:${range.line_start + index}`)))].sort();
  const originalRanges = [...caller.evidence, ...caller.behaviors.flatMap(item => item.evidence), ...caller.dependencies.flatMap(item => item.evidence)];
  assert.deepEqual(rows(ownSources), rows(originalRanges));
  assert.equal(ownSources.length, 1, 'overlapping caller bytes should appear only once in this context');
  const { sha256: _sha, input_sha256: _input, segment_ids: _segments, ...callerFacts } = caller;
  assert.deepEqual(expandEvidence(context.caller, context.evidence_catalog), callerFacts);
  assert.match(context.context_id, /^C[a-f0-9]{16}$/);
  assert.equal('input_sha256' in context, false);
  assert.deepEqual(context.claims.map(({ corrected_requires_definition: _required, ...claim }) => claim), [{ id: 'summary', text: caller.summary }, { id: 'responsibility', text: caller.responsibility },
    { id: 'behavior:0', text: caller.behaviors[0].description }, { id: 'dependency:0', text: caller.dependencies[0].description },
    { id: 'state:0', text: caller.state_owners[0] }, { id: 'purpose:0', text: caller.user_purposes[0] }]);
  assert.deepEqual(context.resolved_dependencies, input.dependencies.map(({ source, target, type, native_ids }) => ({ source, target, type, native_ids })));
  const definition = input.native.nodes.find(node => node.id === 'cg:resolver');
  const calleeSources = context.sources.filter(source => source.path === definition.path);
  assert.deepEqual(calleeSources.map(({ path, line_start, line_end, defines, definition_complete }) => ({ path, line_start, line_end, defines, definition_complete })),
    [{ path: definition.path, line_start: definition.line_start, line_end: definition.line_end, defines: [definition.label], definition_complete: true }]);
  const calleeText = readFileSync(path.join(input.sourceDirectory, definition.path), 'utf8').split('\n').slice(definition.line_start - 1, definition.line_end).join('\n');
  assert.equal(calleeSources[0].text, calleeText); assert.equal('input_sha256' in calleeSources[0], false);
  assert.equal('file_sha256' in calleeSources[0], false);
  assert.ok(context.complete_callee_definition_ids.includes(calleeSources[0].evidence_id));
  assert.ok(requests.every(request => request.verification_version === 'cross-file-claims-1.3.0'));
});

test('caller normalization never authorizes a model citation inside an uncovered source gap', async t => {
  const input = chineseCallerFixture(t), caller = input.briefs.find(brief => brief.path === 'caller.ts');
  caller.evidence = [{ path: caller.path, line_start: 1, line_end: 1 }];
  caller.behaviors[0].evidence = [{ path: caller.path, line_start: 3, line_end: 4 }];
  const client = findingsClient(input, file => file.path === caller.path ? [{ claim_id: 'summary', status: 'uncertain', replacement: '',
    reason: 'The omitted caller row cannot establish this identity rule.', evidence: [{ path: caller.path, line_start: 2, line_end: 2 }] }] : []);
  await assert.rejects(reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined }),
    error => error.code === 'code_analysis_model_invalid' && error.details?.reason === 'consistency_evidence_catalog');
});

test('caller argument forwarding is reconciled against the actual ignored callee parameter, preserving the original facts and independent correction audit', async t => {
  const input = fixture(t); let sawDefinition = false;
  const originalSha = semanticDigest(input.briefs);
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, cacheDirectory: path.join(input.root, 'cache'), fetchImpl: async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    return contextualResponse(request, { files: request.files.map(file => {
      const findings = [];
      if (file.path === 'caller.ts') {
        assert.ok(file.callees.some(callee => callee.path === 'identity.ts'));
        assert.ok(file.sources.some(source => source.path === 'identity.ts' && source.text.includes('void payload') && source.text.includes('return context.authenticatedActor')));
        sawDefinition = true;
        for (const claim_id of ['summary', 'behavior:0']) findings.push({ claim_id, status: 'corrected', replacement: 'The request actor comes from authenticated context; the forwarded payload is ignored by the resolver.', reason: 'The callee implementation explicitly ignores payload and returns the context-owned actor.', evidence: [{ path: 'identity.ts', line_start: 2, line_end: 3 }] });
      }
      return { context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings, unresolved_dependencies: [] };
    }) });
  } });
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
  assert.equal(sawDefinition, true); assert.equal(semanticDigest(input.briefs), originalSha);
  const caller = result.briefs.find(brief => brief.path === 'caller.ts');
  assert.match(caller.summary, /forwarded payload is ignored/); assert.match(caller.behaviors[0].description, /authenticated context/);
  assert.ok(caller.evidence.some(evidence => evidence.path === 'identity.ts')); assert.equal(result.audit.files_checked, 2); assert.equal(result.audit.corrected_claims, 2);
  assert.notEqual(caller.input_sha256, input.briefs[0].input_sha256);
  const audit = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-consistency.json')));
  assert.ok(audit.brief_changes.some(change => change.path === 'caller.ts' && change.before_sha256 !== change.after_sha256));
});

test('a corrected risky helper claim cannot use caller-only evidence when the callee definition was supplied', async t => {
  const input = fixture(t);
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    return contextualResponse(request, { files: request.files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: file.path === 'caller.ts' ? [{ claim_id: 'summary', status: 'corrected', replacement: 'A new guessed identity rule.', reason: 'Guessed from call syntax.', evidence: [{ path: 'caller.ts', line_start: 3, line_end: 3 }] }] : [], unresolved_dependencies: [] })) });
  } });
  await assertHostDowngrade(input, client);
});

test('Chinese identity claims without an English helper name still require actual callee-definition bytes', async t => {
  for (const cite of ['caller-only', 'brief-wide']) {
    const input = chineseCallerFixture(t);
    if (cite === 'brief-wide') input.native.edges = []; // Callee brief exists, but no definition was actually supplied.
    const client = findingsClient(input, file => file.path === 'caller.ts' ? [{ claim_id: 'summary', status: 'corrected', replacement: '身份取自认证上下文，传入的数据不会参与身份确定。', reason: '校验身份来源。', evidence: [{ path: cite === 'caller-only' ? 'caller.ts' : 'identity.ts', line_start: 1, line_end: 3 }] }] : []);
    await assertHostDowngrade(input, client);
  }
  const input = chineseCallerFixture(t);
  const client = findingsClient(input, file => {
    if (file.path !== 'caller.ts') return [];
    assert.equal(file.claims.some(claim => claim.text.includes('resolveActor')), false);
    assert.ok(file.sources.some(source => source.path === 'identity.ts' && source.definition_complete && source.text.includes('void payload')));
    return [{ claim_id: 'summary', status: 'corrected', replacement: '身份取自认证上下文，传入的数据不会参与身份确定。', reason: '完整定义忽略传入数据，只返回认证上下文的主体。', evidence: [{ path: 'identity.ts', line_start: 2, line_end: 3 }] }];
  });
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
  assert.equal(result.audit.corrected_claims, 1); assert.match(result.briefs.find(brief => brief.path === 'caller.ts').summary, /不会参与/);
});

test('missing callee definition keeps a Chinese risky claim uncertain rather than promoting brief-only correction', async t => {
  const input = chineseCallerFixture(t); input.native.edges = [];
  const client = findingsClient(input, file => file.path === 'caller.ts' ? [{ claim_id: 'summary', status: 'uncertain', replacement: '', reason: '当前页没有可用的完整被调用实现，不能由传参形式推断身份来源。', evidence: [{ path: 'caller.ts', line_start: 3, line_end: 3 }] }] : []);
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
  assert.equal(result.audit.corrected_claims, 0); assert.equal(result.audit.uncertain_claims, 1); assert.match(result.briefs.find(brief => brief.path === 'caller.ts').summary, /^待确认/);
});

test('partial or oversized callee definitions cannot be used as complete implementation proof', async t => {
  const input = chineseCallerFixture(t), content = 'export function resolveActor(context, payload) {\n' + '  const padding = "' + 'x'.repeat(17000) + '";\n  void payload;\n  return context.authenticatedActor;\n}\n';
  writeFileSync(path.join(input.sourceDirectory, 'identity.ts'), content);
  const file = input.snapshot.files.find(file => file.path === 'identity.ts'); Object.assign(file, { sha256: semanticDigest(Buffer.from(content)), byte_count: Buffer.byteLength(content), line_count: content.split('\n').length });
  input.native.nodes.find(node => node.id === 'cg:resolver').line_end = 6;
  const client = findingsClient(input, file => {
    if (file.path !== 'caller.ts') return [];
    assert.equal(file.sources.some(source => source.path === 'identity.ts' && source.definition_complete), false);
    return [{ claim_id: 'summary', status: 'corrected', replacement: '身份来自上下文。', reason: '从部分实现推断。', evidence: [{ path: 'identity.ts', line_start: 4, line_end: 5 }] }];
  });
  await assertHostDowngrade(input, client);
});

test('declaration fallback labels only actual names and cannot masquerade as a precise complete definition', async t => {
  const input = fixture(t); input.native.nodes = []; input.native.edges = [];
  const client = findingsClient(input, file => {
    if (file.path !== 'caller.ts') return [];
    const fallback = file.sources.filter(source => source.path === 'identity.ts');
    assert.ok(fallback.length); assert.ok(fallback.every(source => source.definition_complete === false));
    assert.ok(fallback.every(source => JSON.stringify(source.defines) === JSON.stringify(['resolveActor'])));
    return [{ claim_id: 'summary', status: 'corrected', replacement: 'Guessed from a generic file context.', reason: 'The brief mentions the resolver.', evidence: [{ path: 'identity.ts', line_start: 1, line_end: 3 }] }];
  });
  await assertHostDowngrade(input, client);
});

test('mixed corrected and uncertain pages stay uncertain while large repeated reasons fit the public schema without losing private audit', async t => {
  const input = chineseCallerFixture(t), original = readFileSync(path.join(input.sourceDirectory, 'caller.ts'), 'utf8');
  const padding = Array.from({ length: 1100 }, (_, index) => `  // retained source context ${index} ${'x'.repeat(700)}`).join('\n');
  const content = original + padding + '\n'; writeFileSync(path.join(input.sourceDirectory, 'caller.ts'), content);
  const file = input.snapshot.files.find(file => file.path === 'caller.ts'); Object.assign(file, { sha256: semanticDigest(Buffer.from(content)), byte_count: Buffer.byteLength(content), line_count: content.split('\n').length });
  const caller = input.briefs.find(brief => brief.path === 'caller.ts'); caller.sha256 = file.sha256; caller.evidence = [{ path: 'caller.ts', line_start: 1, line_end: file.line_count }]; caller.unknowns = Array.from({ length: 20 }, (_, index) => `Original uncertainty ${index}`);
  let sequence = 0;
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    return contextualResponse(request, { files: request.files.map(file => {
      if (file.path !== 'caller.ts') return { context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: [], unresolved_dependencies: [] };
      const current = ++sequence, complete = file.sources.some(source => source.path === 'identity.ts' && source.definition_complete);
      return { context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: [{ claim_id: 'summary', status: 'corrected', replacement: '身份取自认证上下文。', reason: `Page ${current} ${complete ? 'definition-backed suggestion' : 'still cannot establish complete helper behavior'}`, evidence: [{ path: complete ? 'identity.ts' : 'caller.ts', line_start: complete ? 2 : 3, line_end: 3 }] }], unresolved_dependencies: Array.from({ length: 12 }, (_, index) => `Unresolved dependency interpretation on page ${current}, item ${index}`) };
    }) });
  } });
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
  const reconciled = result.briefs.find(brief => brief.path === 'caller.ts');
  assert.ok(sequence > 10); assert.equal(result.audit.corrected_claims, 0); assert.equal(result.audit.uncertain_claims, 1); assert.match(reconciled.summary, /^待确认/);
  assert.ok(result.audit.host_downgraded_findings > 0); assert.equal(result.audit.applied_corrected_claims, 0);
  assert.ok(reconciled.unknowns.length + reconciled.behaviors.length <= 100); assert.ok(reconciled.unknowns.every(reason => reason.length <= 4000));
  assert.ok(reconciled.unknowns.some(reason => reason.includes('另') && reason.includes('完整保留于审计')));
  assert.ok(reconciled.unknowns.some(reason => reason.includes('未采纳纠正建议') || reason.includes('待确认')));
  const checks = result.audit.checks.filter(check => check.path === 'caller.ts');
  assert.equal(checks.flatMap(check => check.unresolved_dependencies).length, sequence * 12);
  assert.ok(checks.some(check => check.findings.some(finding => finding.status === 'corrected'))); assert.ok(checks.some(check => check.findings.some(finding => finding.status === 'uncertain')));
});

test('context identity, claim coverage, per-context catalogs and strict wire shape get one precise safe repair', async t => {
  for (const mode of ['identity', 'coverage', 'catalog', 'status', 'array-status', 'duplicate-evidence', 'wrong-replacement', 'free-range', 'extra-hash', 'duplicate-context']) {
    const input = fixture(t), marker = 'untrusted-value-12345', prompts = []; let expectedContexts, expectedEvidence;
    const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, request) => {
      const prompt = JSON.parse(JSON.parse(request.body).messages[1].content); prompts.push(prompt);
      const rows = prompt.files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: [], unresolved_dependencies: [] }));
      if (prompts.length === 1) {
        expectedContexts = prompt.files.map(file => file.context_id); expectedEvidence = prompt.files[0].evidence_catalog.map(entry => entry.id);
        if (mode === 'identity') rows[0].context_id = marker;
        if (mode === 'coverage') rows[0].checked_claims.pop();
        if (mode === 'duplicate-context') rows[1] = structuredClone(rows[0]);
        if (mode === 'extra-hash') rows[0].input_sha256 = marker;
        if (['catalog', 'status', 'array-status', 'duplicate-evidence', 'wrong-replacement', 'free-range'].includes(mode)) {
          rows[0].findings = [{ claim_id: 'summary', status: mode === 'status' ? marker : 'corrected', replacement: 'A proposed identity correction.', reason: 'A proposed explanation.', evidence_ids: mode === 'catalog' ? [marker] : [expectedEvidence[0]] }];
          if (mode === 'array-status') rows[0].findings[0].status = ['corrected'];
          if (mode === 'duplicate-evidence') rows[0].findings[0].evidence_ids.push(expectedEvidence[0]);
          if (mode === 'wrong-replacement') rows[0].findings[0].replacement = 1;
          if (mode === 'free-range') { delete rows[0].findings[0].evidence_ids; rows[0].findings[0].evidence = [{ path: marker, line_start: 1, line_end: 99 }]; }
        }
      } else {
        assert.ok(prompt.correction.fields.length); assert.ok(prompt.correction.constraints.length);
        assert.equal(JSON.stringify(prompt.correction).includes(marker), false);
        if (mode === 'identity' || mode === 'duplicate-context') assert.ok(prompt.correction.constraints.some(issue => JSON.stringify(issue.allowed_values) === JSON.stringify(expectedContexts)));
        if (mode === 'catalog') assert.ok(prompt.correction.constraints.some(issue => JSON.stringify(issue.allowed_values) === JSON.stringify(expectedEvidence)));
        if (mode === 'coverage') assert.ok(prompt.correction.constraints.some(issue => issue.rule === 'exact_items' && issue.allowed_values.includes('summary') && issue.observed_count < issue.minimum));
        if (['status', 'array-status'].includes(mode)) assert.ok(prompt.correction.constraints.some(issue => JSON.stringify(issue.allowed_values) === JSON.stringify(['corrected', 'uncertain'])));
        if (mode === 'duplicate-evidence') assert.ok(prompt.correction.constraints.some(issue => issue.rule === 'unique_items'));
        if (mode === 'wrong-replacement') assert.ok(prompt.correction.constraints.some(issue => issue.expected === 'string' && issue.observed_type === 'number'));
      }
      return modelResponse({ files: rows });
    } });
    const result = await reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined });
    assert.equal(prompts.length, 2); assert.equal(result.audit.host_downgraded_findings, 0); assert.equal(result.audit.files_checked, 2);
    for (const name of readdirSync(input.runDirectory).filter(name => name.endsWith('.audit.json'))) assert.equal(readFileSync(path.join(input.runDirectory, name), 'utf8').includes(marker), false);
  }
});

test('a known ID from another caller catalog never widens this context and cannot become a host uncertainty fallback', async t => {
  const input = fixture(t); let attempts = 0;
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, request) => {
    attempts++; const prompt = JSON.parse(JSON.parse(request.body).messages[1].content);
    const caller = prompt.files.find(file => file.path === 'caller.ts'), other = prompt.files.find(file => file.path === 'identity.ts');
    const foreignId = caller.evidence_catalog.find(entry => !other.evidence_catalog.some(allowed => allowed.id === entry.id)).id;
    return modelResponse({ files: prompt.files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: file.path === 'identity.ts' ? [{ claim_id: 'summary', status: 'corrected', replacement: 'A guessed rule.', reason: 'Uses another context catalog.', evidence_ids: [foreignId] }] : [], unresolved_dependencies: [] })) });
  } });
  await assert.rejects(reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined }), error => error.details.reason === 'consistency_evidence_catalog');
  assert.equal(attempts, 2); assert.equal(existsSync(path.join(input.runDirectory, 'semantic-consistency.json')), false);
});

test('identical short context identities are rejected by the full host binding before provider execution', async t => {
  const input = fixture(t); input.briefs.push(structuredClone(input.briefs[0])); let calls = 0;
  const client = { call: async () => { calls++; assert.fail('Collision must fail before model execution'); } };
  await assert.rejects(reconcileSemanticBriefs({ ...input, client, parallel: async (items, action) => Promise.all(items.map(action)), onProgress: async () => undefined }), error => error.details.reason === 'consistency_context_collision');
  assert.equal(calls, 0);
});

function manyNeighborFixture(t) {
  const input = fixture(t), caller = input.briefs[0], callerFile = input.snapshot.files[0], callerNode = input.native.nodes[0];
  input.briefs = [caller]; input.snapshot.files = [callerFile]; input.native = { nodes: [callerNode], edges: [] }; input.dependencies = [];
  for (let index = 0; index < 37; index++) {
    const name = `callee-${index}.ts`, content = `export function resolveActor${index}(context, payload) {\n  void payload;\n  return context.authenticatedActor;\n}\n`;
    writeFileSync(path.join(input.sourceDirectory, name), content);
    const file = { path: name, sha256: semanticDigest(Buffer.from(content)), byte_count: Buffer.byteLength(content), line_count: content.split('\n').length }, evidence = [{ path: name, line_start: 1, line_end: 4 }];
    input.snapshot.files.push(file); input.briefs.push({ ...structuredClone(caller), path: name, sha256: file.sha256, input_sha256: semanticDigest(file), evidence, behaviors: [{ description: 'Returns the authenticated identity from context.', evidence }] });
    input.native.nodes.push({ id: `cg:callee:${index}`, kind: 'function', label: `resolveActor${index}`, path: name, line_start: 1, line_end: 4 });
    const id = `cg-edge:${index}`; input.native.edges.push({ id, source: callerNode.id, target: `cg:callee:${index}`, type: 'calls' });
    input.dependencies.push({ id, source: caller.path, target: name, type: 'calls', native_ids: [id], count: 1, evidence: [...caller.evidence, ...evidence] });
  }
  return input;
}
const completeRows = files => files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: [], unresolved_dependencies: [] }));
async function fourSlots(items, action) {
  const result = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => { while (next < items.length) { const index = next++; result[index] = await action(items[index], index); } }));
  return result;
}

test('concrete skeleton covers four same-path contexts and producer splits retain every identity, claim and source within four slots', async t => {
  const input = manyNeighborFixture(t), original = semanticDigest(input.briefs), contexts = new Map(), progress = []; let active = 0, peak = 0, requests = 0;
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, cacheDirectory: path.join(input.root, 'cache'), fetchImpl: async (_url, request) => {
    requests++; const prompt = JSON.parse(JSON.parse(request.body).messages[1].content); active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--;
    assert.equal(prompt.coverage_protocol, 'concrete-context-coverage-1.1.0'); assert.equal(prompt.coverage_constraints.exact_count, prompt.files.length);
    assert.deepEqual(prompt.output_shape.files, completeRows(prompt.files));
    for (const file of prompt.files) { const before = contexts.get(file.context_id); if (before) assert.deepEqual(file, before); else contexts.set(file.context_id, file); }
    const rows = completeRows(prompt.files), sharedCaller = prompt.files.every(file => file.path === 'caller.ts');
    return modelResponse({ files: sharedCaller && prompt.files.length > 1 ? rows.slice(0, -1) : rows });
  } });
  const result = await reconcileSemanticBriefs({ ...input, client, parallel: fourSlots, onProgress: async (completed, total) => progress.push({ completed, total }) });
  assert.ok(peak > 1 && peak <= 4); assert.equal(result.audit.contexts_checked, 41); assert.equal(result.audit.checks.length, 41);
  assert.equal(new Set(result.audit.checks.map(check => check.input_sha256)).size, 41); assert.equal(result.audit.splits.length, 3);
  assert.ok(result.audit.splits.some(split => split.context_ids.length === 4)); assert.equal(client.metrics().calls, requests);
  assert.equal(progress.length, progress[0].total + 1); assert.deepEqual(progress.map(item => item.completed), Array.from({ length: progress.length }, (_, index) => index));
  assert.equal(semanticDigest(input.briefs), original); assert.ok(readdirSync(input.runDirectory).filter(name => name.startsWith('semantic-consistency-split-')).length === 3);
});

test('actual concrete prompt defines every finding field despite an empty skeleton and rejects model-authored host audit fields', async t => {
  for (const forbidden of ['host_reason', 'original_proposal']) {
    const input = fixture(t), allowed = ['claim_id', 'status', 'replacement', 'reason', 'evidence_ids']; let calls = 0;
    const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, request) => {
      calls++; const prompt = JSON.parse(JSON.parse(request.body).messages[1].content), schema = prompt.finding_item_schema;
      assert.equal(prompt.coverage_protocol, 'concrete-context-coverage-1.1.0'); assert.deepEqual(prompt.output_shape.files, completeRows(prompt.files));
      assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, allowed); assert.deepEqual(Object.keys(schema.properties), allowed);
      assert.deepEqual(schema.properties.status.enum, ['corrected', 'uncertain']); assert.equal(schema.properties.replacement.maxLength, 1200); assert.equal(schema.properties.reason.maxLength, 600);
      assert.equal(schema.properties.evidence_ids.maxItems, 20); assert.equal(schema.properties.evidence_ids.minItems, 1); assert.equal(schema.properties.evidence_ids.uniqueItems, true);
      assert.equal(schema.allOf[0].else.properties.replacement.maxLength, 800); assert.equal(schema.allOf[1].then.properties.replacement.const, '');
      const rows = completeRows(prompt.files), context = prompt.files[0], constraints = prompt.finding_context_constraints.find(row => row.context_id === context.context_id);
      assert.deepEqual(constraints.allowed_claim_ids, context.claims.map(claim => claim.id)); assert.deepEqual(constraints.allowed_evidence_ids, context.evidence_catalog.map(entry => entry.id));
      rows[0].findings = [{ claim_id: 'summary', status: 'uncertain', replacement: '', reason: 'The supplied definitions do not establish this claim.', evidence_ids: [context.evidence_catalog[0].id], ...(calls === 1 ? { [forbidden]: 'untrusted-model-authored-audit' } : {}) }];
      if (calls === 2) {
        assert.ok(prompt.correction.constraints.some(issue => issue.rule === 'unexpected_fields' && JSON.stringify(issue.allowed_values) === JSON.stringify(allowed)));
        assert.equal(JSON.stringify(prompt.correction).includes('untrusted-model-authored-audit'), false);
      }
      return modelResponse({ files: rows });
    } });
    const result = await reconcileSemanticBriefs({ ...input, client, parallel: fourSlots, onProgress: async () => undefined });
    assert.equal(calls, 2); assert.equal(result.audit.uncertain_claims, 1); assert.equal(result.audit.host_downgraded_findings, 0);
    const finding = result.audit.checks[0].findings[0]; assert.equal('host_reason' in finding, false); assert.equal('original_proposal' in finding, false);
  }
});

test('a successful left leaf is reused after a failed right leaf without accepting the incomplete parent', async t => {
  const input = fixture(t), leafCalls = { 'caller.ts': 0, 'identity.ts': 0 }; let failRight = true;
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, cacheDirectory: path.join(input.root, 'cache'), fetchImpl: async (_url, request) => {
    const prompt = JSON.parse(JSON.parse(request.body).messages[1].content), rows = completeRows(prompt.files);
    if (prompt.files.length > 1) return modelResponse({ files: rows.slice(0, 1) });
    const file = prompt.files[0]; leafCalls[file.path]++;
    if (file.path === 'identity.ts' && failRight) return new Response(JSON.stringify({ model: 'wrong-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ files: rows }) } }] }));
    return modelResponse({ files: rows });
  } });
  const run = () => reconcileSemanticBriefs({ ...input, client, parallel: fourSlots, onProgress: async () => undefined });
  await assert.rejects(run(), error => error.details.reason === 'model_identity'); assert.equal(existsSync(path.join(input.runDirectory, 'semantic-consistency.json')), false);
  assert.deepEqual(leafCalls, { 'caller.ts': 1, 'identity.ts': 1 }); failRight = false;
  const result = await run(); assert.equal(result.audit.contexts_checked, 2); assert.deepEqual(leafCalls, { 'caller.ts': 1, 'identity.ts': 2 });
});

test('cancellation after the left leaf prevents both cached and provider work for the right leaf', async t => {
  const input = fixture(t), controller = new AbortController(); let rightCalls = 0;
  const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', signal: controller.signal, runDirectory: input.runDirectory, fetchImpl: async (_url, request) => {
    const prompt = JSON.parse(JSON.parse(request.body).messages[1].content), rows = completeRows(prompt.files);
    if (prompt.files.length > 1) return modelResponse({ files: rows.slice(0, 1) });
    if (prompt.files[0].path === 'caller.ts') controller.abort(); else rightCalls++;
    return modelResponse({ files: rows });
  } });
  await assert.rejects(reconcileSemanticBriefs({ ...input, client, parallel: fourSlots, onProgress: async () => undefined }), { code: 'code_analysis_cancelled' });
  assert.equal(rightCalls, 0); assert.equal(existsSync(path.join(input.runDirectory, 'semantic-consistency.json')), false);
});

test('forbidden failures never trigger adaptive splitting and a bad single context remains a hard failure', async t => {
  for (const mode of ['identity', 'sensitive', 'catalog', 'transport', 'single', 'source']) {
    const input = fixture(t); let calls = 0;
    if (mode === 'single') { input.briefs = [input.briefs[0]]; input.dependencies = []; input.native.edges = []; }
    if (mode === 'source') writeFileSync(path.join(input.sourceDirectory, 'caller.ts'), 'Changed bytes after the snapshot was captured.');
    const client = createSemanticModelClient({ config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '' }, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'fixture', runDirectory: input.runDirectory, fetchImpl: async (_url, request) => {
      calls++; if (mode === 'transport') return new Response('{}', { status: 400 });
      const prompt = JSON.parse(JSON.parse(request.body).messages[1].content), rows = completeRows(prompt.files);
      if (mode === 'identity') return new Response(JSON.stringify({ model: 'wrong-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ files: rows }) } }] }));
      if (mode === 'sensitive') rows[0].unresolved_dependencies = ['password = "unsafe-test-literal"'];
      if (mode === 'catalog') rows[0].findings = [{ claim_id: 'summary', status: 'corrected', replacement: 'A guessed rule.', reason: 'A proposed explanation.', evidence_ids: ['UNKNOWN'] }];
      return modelResponse({ files: mode === 'single' ? [] : rows });
    } });
    await assert.rejects(reconcileSemanticBriefs({ ...input, client, parallel: fourSlots, onProgress: async () => undefined }));
    assert.equal(calls, mode === 'source' ? 0 : ['identity', 'transport'].includes(mode) ? 1 : 2); assert.equal(readdirSync(input.runDirectory).some(name => name.startsWith('semantic-consistency-split-')), false);
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = readFileSync(new URL('../src/memory-material-runtime.ts', import.meta.url), 'utf8').replace(/^import[^;]+;\r?\n/gmu, '');
let sequence = 0;

// Execute the production worker with deterministic PG/HTTP boundaries. No DB,
// credentials, native source mutation, or real semantic engine is involved.
async function fixture() {
  const jobs = [{ id: '1', code: 'INDEX', projectId: '1', project: 'PROJECT', bindingGeneration: null,
    sourceKind: 'project', objectCode: 'OBJECT', revision: 1, revisionCode: 'REV1', metadataHash: 'hash',
    sourceCitation: 'REV1', path: 'project/OBJECT.md', title: 'Old title', summary: 'Old summary',
    summaryOrigin: 'authored', textSearchable: true, active: true, legacy: false, text: null,
    titleTruncated: false, externalRef: null, operation: 'upsert', generation: 1, attempts: 0, status: 'pending', lastError: null }];
  const pages = new Map(), messages = new Map(), locks = new Map(), hooks = {}, calls = [];
  const mapping = { wikiId: 'old-wiki', teamId: 'team', userId: 'writer', semanticAgentId: 'core' };
  const config = { tencent: { baseUrl: 'https://engine.invalid', coreBaseUrl: 'https://engine.invalid', token: 'fake', serviceId: 'fake' }, projects: { PROJECT: mapping } };
  let current = true, bindingGeneration = null, skipNextLock = false;
  const result = rows => ({ rows, rowCount: rows.length });
  const same = (job, args) => job.id === args[0] && job.attempts === args[1] && job.generation === args[2] && job.operation === args[3];
  async function query(text, args = []) {
    if (text.startsWith('with candidate')) {
      const job = jobs.find(row => row.status === 'pending' || row.retry);
      if (!job) return result([]);
      job.status = 'processing'; job.retry = false; job.attempts++;
      return result([{ ...job, bindingGeneration }]);
    }
    const job = jobs.find(row => row.id === args[0]);
    if (text.startsWith('select id from memory_projection_jobs')) return result(job && same(job, args) && job.status === 'processing' ? [{ id: job.id }] : []);
    if (text.includes("operation='delete',generation=generation+1")) {
      if (job && same(job, [...args.slice(0, 3), 'upsert'])) { job.operation = 'delete'; job.generation++; job.status = 'pending'; if (args[3] !== 'upsert') job.externalRef = args[3]; return result([{ id: job.id }]); }
      return result([]);
    }
    if (text.includes('stale_upsert_cleanup')) {
      const eligible = job && (job.operation === 'delete' && job.generation !== args[1] || args[3] && (job.generation !== args[1] || job.attempts !== args[4]));
      if (!eligible || job.externalRef !== null && job.externalRef !== args[2] && job.externalRef !== args[2] + '#uncertain-material-write') return result([]);
      job.externalRef ??= args[2];
      if (args[3]) { if (job.status === 'synced') { if (job.operation === 'delete') job.generation++; job.status = 'needs_reconcile'; } job.lastError = 'uncertain_material_write'; job.externalRef = args[2] + '#uncertain-material-write'; }
      else if (job.status === 'synced') { job.status = 'pending'; job.generation++; job.lastError = 'stale_upsert_cleanup'; }
      return result([{ id: job.id }]);
    }
    if (text.includes('set external_ref=$5')) {
      if (!job || !same(job, args) || job.status !== 'processing' || job.externalRef !== args[5]) return result([]);
      job.externalRef = args[4]; return result([{ id: job.id }]);
    }
    if (text.includes('set status=$5')) {
      if (job && same(job, args) && job.status === 'processing') { job.status = args[4]; job.lastError = args[5]; job.externalRef = args[6]; return result([{ id: job.id }]); }
      return result([]);
    }
    throw Error('Unexpected SQL: ' + text);
  }
  const db = { $client: { query, async connect() {
    let unlock;
    const skip = skipNextLock; skipNextLock = false;
    return { async query(text, args) {
      if (text === 'BEGIN') return result([]);
      if (text === 'COMMIT' || text === 'ROLLBACK') { unlock?.(); return result([]); }
      if (text.includes('pg_advisory_xact_lock')) {
        if (skip) return result([]); // A worker from before deployment does not hold the new lock.
        const key = args[0], previous = locks.get(key) ?? Promise.resolve(), gate = deferred();
        locks.set(key, previous.then(() => gate.promise));
        hooks.waiting?.(key); await previous; unlock = gate.resolve; return result([]);
      }
      return query(text, args);
    }, release() { unlock?.(); } };
  } }, async transaction(work) {
    return work({ async execute(statement) {
      const { text, values } = statement;
      if (text.includes('pg_advisory')) return result([]);
      const [ref, id, attempts, generation, operation] = text.includes('set status=case') ? [null, ...values.slice(3)] : values;
      const job = jobs.find(row => row.id === id);
      if (text.includes("set status='synced'") || text.includes('set status=case')) {
        hooks.beforeAck?.(job);
        if (!job || !same(job, [id, attempts, generation, operation]) || job.status !== 'processing') return result([]);
        job.status = job.externalRef?.endsWith('#uncertain-material-write') ? 'needs_reconcile' : 'synced';
        job.lastError = job.status === 'synced' ? null : 'uncertain_material_write';
        if (ref !== null) job.externalRef = ref; return result([{ id, status: job.status }]);
      }
      throw Error('Unexpected transaction SQL: ' + text);
    }, select: () => ({ from: table => ({ where: async () => table === 'projects' ? [{ status: 'active' }] : bindingGeneration === null ? [] : [{ generation: bindingGeneration, enabled: true, state: 'ready' }] }) }) });
  } };
  async function fetch(url, opts) {
    const operation = new URL(url).pathname, body = JSON.parse(opts.body);
    calls.push({ operation, body });
    const key = body.wiki_id, pageKey = ref => key + '/' + ref;
    let data;
    if (operation === '/wiki/get') data = { wiki_id: key, team_id: 'team', name: 'tsp-memory-PROJECT', status: 'ready' };
    else if (operation === '/wiki/page/read') { hooks.beforeRead?.(body); data = { items: body.refs.map(ref => pages.has(pageKey(ref)) ? { ref, content: pages.get(pageKey(ref)) } : { ref, not_found: true }) }; }
    else if (operation === '/wiki/page/write') {
      await hooks.beforeWrite?.(body);
      for (const page of body.pages) pages.set(pageKey(page.ref), page.content);
      await hooks.afterWrite?.(body); data = {};
    } else if (operation === '/wiki/page/rm') { for (const ref of body.refs) pages.delete(pageKey(ref)); data = {}; }
    else if (operation === '/wiki/search') data = { results: hooks.searchPending ? [] : [...pages.keys()].filter(ref => ref.startsWith(key + '/')).map(ref => ({ path: ref.slice(key.length + 1) })) };
    else if (operation === '/conversation/query') { hooks.beforeCoreRead?.(body); const rows = messages.get(body.session_id) ?? []; data = { messages: rows, total: rows.length }; }
    else if (operation === '/conversation/add') { messages.set(body.session_id, body.messages.map((row, i) => ({ ...row, id: 'message-' + i }))); hooks.afterCoreAdd?.(body); data = {}; }
    else if (operation === '/conversation/delete') { for (const [session, rows] of messages) messages.set(session, rows.filter(row => !body.message_ids.includes(row.id))); data = {}; }
    else throw Error('Unexpected fake endpoint: ' + operation);
    return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
  }
  const key = 'materialRaceFixture' + ++sequence;
  globalThis[key] = { fetch, resolve: async () => ({ generation: bindingGeneration, config }), current: async () => current ? { metadataHash: 'hash', revisionCode: 'REV1' } : null };
  const prefix = `import { createHash } from 'node:crypto';
    const { fetch, resolve: resolveProjectMemoryEngines, current: resolveCurrentProjectMaterialSource } = globalThis[${JSON.stringify(key)}];
    const eq = (...args) => args;
    const sql = (parts, ...values) => ({text: parts.join('?'), values});
    const schema = {projects: 'projects', projectMemoryBindings: 'bindings'};`;
  const javascript = ts.transpileModule(prefix + source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const module = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
  delete globalThis[key];
  return { jobs, pages, messages, hooks, calls, config, run: () => module.projectNextMaterialIndex(db, config),
    retire() { current = false; const job = jobs[0]; job.operation = 'delete'; job.generation++; job.status = 'pending'; job.lastError = null; },
    legacyWorker() { skipNextLock = true; }, rebind() { config.projects.PROJECT = { ...mapping, wikiId: 'new-wiki' }; bindingGeneration = 2; },
    addIndependent() { jobs.push({ ...jobs[0], id: '2', code: 'OTHER', externalRef: null, status: 'pending', attempts: 0 }); },
    retry() { jobs[0].retry = true; }, copies: () => [...messages.values()].flat().length };
}

test('a late pre-lock worker reopens a completed delete and removes both copies on retry', async () => {
  const fx = await fixture(), entered = deferred(), release = deferred();
  fx.hooks.beforeWrite = async () => { entered.resolve(); await release.promise; };
  const late = fx.run(); await entered.promise; fx.retire(); fx.legacyWorker();
  assert.equal((await fx.run()).status, 'synced');
  release.resolve(); assert.equal((await late).status, 'source_unavailable');
  assert.equal(fx.jobs[0].status, 'pending');
  assert.equal((await fx.run()).status, 'synced');
  assert.equal(fx.pages.size, 0); assert.equal(fx.copies(), 0);
});

test('compliant workers serialize one material while a different material keeps progressing', async () => {
  const fx = await fixture(), entered = deferred(), release = deferred(), waiting = deferred();
  fx.hooks.beforeWrite = async body => { if (body.pages[0].content.includes('"indexCode":"INDEX"')) { entered.resolve(); await release.promise; } };
  const old = fx.run(); await entered.promise; fx.retire(); fx.hooks.waiting = waiting.resolve;
  const deletion = fx.run(); await waiting.promise;
  let finished = false; deletion.then(() => { finished = true; });
  fx.addIndependent(); assert.equal((await fx.run()).status, 'synced');
  assert.equal(finished, false);
  release.resolve(); await old; assert.equal((await deletion).status, 'synced');
  assert.equal(fx.pages.size, 0); assert.equal(fx.copies(), 0);
});

test('uncertain late writes keep cleanup retryable even after a successful readback', async () => {
  const fx = await fixture(), entered = deferred(), release = deferred();
  fx.hooks.beforeWrite = async () => { entered.resolve(); await release.promise; };
  fx.hooks.afterWrite = () => { throw Error('Connection closed after accepting write'); };
  const late = fx.run(); await entered.promise; fx.retire(); fx.legacyWorker(); await fx.run();
  release.resolve(); await late;
  assert.equal(fx.jobs[0].status, 'needs_reconcile'); assert.equal(fx.jobs[0].lastError, 'uncertain_material_write');
  fx.retry(); assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.equal(fx.pages.size, 0); assert.equal(fx.copies(), 0);
  // The timed-out upstream request may apply even later. Its cleanup remains scheduled.
  fx.pages.set('old-wiki/' + 'wiki/sources/tsp-material-' + createHash('sha256').update('PROJECT/INDEX').digest('hex') + '.md', fx.calls.find(row => row.operation === '/wiki/page/write').body.pages[0].content);
  fx.retry(); await fx.run(); assert.equal(fx.pages.size, 0); assert.equal(fx.jobs[0].status, 'needs_reconcile');
});

test('a binding switch retains the old resource receipt and protects unknown remote content', async () => {
  const fx = await fixture(), entered = deferred(), release = deferred();
  fx.hooks.beforeWrite = async () => { entered.resolve(); await release.promise; };
  const late = fx.run(); await entered.promise; fx.retire(); fx.rebind();
  release.resolve(); await late;
  assert.match(fx.jobs[0].externalRef, /^wiki:old-wiki\//u);
  const page = [...fx.pages.keys()][0]; fx.pages.set(page, 'unknown owner content');
  assert.equal((await fx.run()).code, 'remote_content_changed');
  assert.equal(fx.pages.get(page), 'unknown owner content');
  assert.equal(fx.calls.filter(row => row.operation === '/wiki/page/rm').length, 0);
  assert.equal(fx.calls.filter(row => row.operation === '/wiki/page/write' && row.body.wiki_id === 'new-wiki').length, 0);
});

test('a failed acknowledgement cannot hide a completed newer cleanup', async () => {
  const fx = await fixture();
  fx.hooks.beforeAck = job => { job.generation++; job.operation = 'delete'; job.status = 'synced'; };
  assert.equal((await fx.run()).status, 'lease_changed');
  assert.equal(fx.jobs[0].status, 'pending');
});

test('source and binding reconciliation cannot erase an uncertain delivery qualifier', async () => {
  const fx = await fixture();
  fx.hooks.afterWrite = () => { throw Error('Timed out after upstream accepted'); };
  assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.match(fx.jobs[0].externalRef, /#uncertain-material-write$/u);
  fx.retire(); fx.rebind(); // Both existing reconcilers clear last_error.
  assert.equal(fx.jobs[0].lastError, null);
  assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.equal(fx.jobs[0].lastError, 'uncertain_material_write');
  assert.equal(fx.pages.size, 0);
  assert.ok(fx.calls.filter(row => row.operation === '/wiki/page/rm').every(row => row.body.wiki_id === 'old-wiki'));
});

test('a forged receipt path cannot authorize deletion of another resource', async () => {
  const fx = await fixture(); fx.retire();
  fx.jobs[0].externalRef = 'wiki:old-wiki/wiki/sources/someone-else.md';
  assert.equal((await fx.run()).code, 'identity_mismatch');
  assert.equal(fx.calls.length, 0);
});

test('an uncertain old attempt qualifies a newer upsert receipt without replacing its intent', async () => {
  const fx = await fixture();
  fx.hooks.afterWrite = () => { fx.jobs[0].attempts++; throw Error('Old attempt lost its connection'); };
  await fx.run();
  assert.equal(fx.jobs[0].operation, 'upsert'); assert.equal(fx.jobs[0].attempts, 2);
  assert.match(fx.jobs[0].externalRef, /#uncertain-material-write$/u);
  fx.retire(); await fx.run();
  assert.equal(fx.pages.size, 0); assert.equal(fx.jobs[0].status, 'needs_reconcile');
});

test('an active synced index is reprojected after a valid binding replacement', async () => {
  const fx = await fixture();
  assert.equal((await fx.run()).status, 'synced');
  const previousRef = fx.jobs[0].externalRef;
  fx.rebind(); fx.jobs[0].status = 'pending'; // completeProvision retains the prior receipt.
  assert.equal((await fx.run()).status, 'synced');
  assert.notEqual(fx.jobs[0].externalRef, previousRef);
  assert.match(fx.jobs[0].externalRef, /^wiki:new-wiki\//u);
  assert.equal(fx.pages.size, 1); assert.equal(fx.copies(), 1);
  assert.ok([...fx.pages.keys()].every(ref => ref.startsWith('new-wiki/')));
});

test('a successful write followed by temporary indexing lag can retry to synced', async () => {
  const fx = await fixture(); fx.hooks.searchPending = true;
  assert.equal((await fx.run()).code, 'wiki_index_pending');
  assert.doesNotMatch(fx.jobs[0].externalRef, /#uncertain-material-write$/u);
  fx.hooks.searchPending = false; fx.retry();
  assert.equal((await fx.run()).status, 'synced');
  assert.equal(fx.calls.filter(row => row.operation === '/wiki/page/write').length, 1);
  assert.equal(fx.pages.size, 1); assert.equal(fx.copies(), 1);
});

test('temporary readback failure after a confirmed write leaves an ordinary retry', async () => {
  const fx = await fixture(); let reads = 0;
  fx.hooks.beforeRead = () => { if (++reads === 2) throw Error('Read service temporarily unavailable'); };
  assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.doesNotMatch(fx.jobs[0].externalRef, /#uncertain-material-write$/u);
  fx.retry(); assert.equal((await fx.run()).status, 'synced');
  assert.equal(fx.calls.filter(row => row.operation === '/wiki/page/write').length, 1);
});

test('binding replacement retains an uncertain old target instead of authorizing a new-target cleanup', async () => {
  const fx = await fixture();
  fx.hooks.afterWrite = () => { throw Error('Mutation response was lost'); };
  await fx.run(); const previousRef = fx.jobs[0].externalRef;
  fx.rebind(); fx.jobs[0].status = 'pending'; fx.jobs[0].lastError = null;
  assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.equal(fx.jobs[0].externalRef, previousRef);
  assert.ok(fx.calls.filter(row => row.operation === '/wiki/page/rm').every(row => row.body.wiki_id === 'old-wiki'));
  assert.equal(fx.calls.filter(row => row.operation === '/wiki/page/write' && row.body.wiki_id === 'new-wiki').length, 0);
});

test('temporary Core read failure after confirmed add retries without a permanent qualifier or duplicate', async () => {
  const fx = await fixture(); let reads = 0;
  fx.hooks.beforeCoreRead = () => { if (++reads === 2) throw Error('Core read temporarily unavailable'); };
  assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.doesNotMatch(fx.jobs[0].externalRef, /#uncertain-material-write$/u);
  fx.retry(); assert.equal((await fx.run()).status, 'synced');
  assert.equal(fx.copies(), 1);
  assert.equal(fx.calls.filter(row => row.operation === '/conversation/add').length, 1);
});

test('a genuinely ambiguous Core add retains its qualifier through deletion', async () => {
  const fx = await fixture();
  fx.hooks.afterCoreAdd = () => { throw Error('Core accepted add but its response was lost'); };
  assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.match(fx.jobs[0].externalRef, /#uncertain-material-write$/u);
  fx.retire(); assert.equal((await fx.run()).status, 'needs_reconcile');
  assert.equal(fx.pages.size, 0); assert.equal(fx.copies(), 0);
});

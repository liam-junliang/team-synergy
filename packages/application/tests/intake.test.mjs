import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@team-synergy/persistence';
import { intakeManifestText } from '@team-synergy/contracts';
import { createIntakeUseCases } from '../dist/index.js';
import { seedWorkspaceProject, useTestDb, insertUser } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.data; };
const bad = (value, code) => { assert.equal(value.ok, false, JSON.stringify(value)); if (code) assert.equal(value.error.code, code); };
const files = [{ path: 'src/auth.ts', sha256: hash('source') }];
const evidence = [{ ...files[0], line_start: 1, line_end: 3, symbol: 'authorize' }];
const candidate = (key, kind, extra = {}) => ({ key, kind, title: key, summary: 'Observed behavior', content_markdown: '# Contract\nChecked behavior.', evidence,
  assessment: 'observed_in_code', tests: [], gaps: ['Browser behavior not verified'], ...extra });
async function seeded() {
  const db = fixture.db;
  const ctx = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'owner', displayName: 'Owner', projectRole: 'owner' },
    { key: 'admin', account: 'admin', displayName: 'Admin', projectRole: 'admin' },
    { key: 'member', account: 'member', displayName: 'Member', projectRole: 'member' },
    { key: 'viewer', account: 'viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  const systemAdmin = await insertUser(db, { account: 'sysadmin', displayName: 'System administrator', isSystemAdmin: true });
  const [repo] = await db.insert(schema.projectRepositories).values({ project_id: ctx.project.id, name: 'Source', remote_url: 'https://example.test/repo.git',
    created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const bundle = { schema_version: 1, project_code: ctx.project.code, repository_code: repo.code, namespace: 'pilot', source: {
    commit: 'a'.repeat(40), dirty: true, scope: ['src'], files, manifest_sha256: hash(intakeManifestText(files)), complete: false,
    exclusions: ['Browser runtime was not inspected'], analyzed_at: '2026-10-18T00:00:00.000Z', skill_version: '1.0.0',
  }, items: [candidate('auth', 'module'), candidate('login', 'feature', { module_key: 'auth' }),
    candidate('guide', 'requirement_document', { module_key: 'auth', summary: '' }),
    candidate('rule', 'requirement', { module_key: 'auth', feature_key: 'login', document_key: 'guide' }),
    candidate('diagram', 'architecture', { diagram_source: 'flowchart LR\nWeb --> API' })] };
  const uc = createIntakeUseCases(db), command = { projectCode: ctx.project.code, principalCode: ctx.users.owner.code };
  return { ...ctx, db, repo, bundle, uc, command, systemAdmin };
}
async function draft(ctx, key = 'submit') { return ok(await ctx.uc.submit({ ...ctx.command, principalCode: ctx.users.member.code, bundle: ctx.bundle, idempotencyKey: key })); }
async function reviewed(ctx, batch, decisions) { return ok(await ctx.uc.review({ ...ctx.command, code: batch.code,
  input: { base_revision: batch.revision, decisions: decisions ?? batch.items.map(({ item }) => ({ key: item.key, action: 'create' })) } })); }
async function publish(ctx, batch, key = 'apply') { return ctx.uc.apply({ ...ctx.command, code: batch.code, input: { plan_hash: batch.plan_hash, idempotency_key: key } }); }
async function count(db, table) { return (await db.select().from(table)).length; }

test('submitting candidates is isolated, member-visible, and source manifest facts remain explicit', async () => {
  const ctx = await seeded(), batch = await draft(ctx);
  assert.equal(batch.status, 'draft'); assert.equal(batch.source.complete, false); assert.equal(batch.source.dirty, true);
  assert.equal(batch.items.length, 5); assert.equal(batch.created_by, ctx.users.member.code);
  for (const table of [schema.projectModules, schema.features, schema.requirements, schema.requirementDocuments, schema.architectureDocuments]) assert.equal(await count(ctx.db, table), 0);
  assert.equal(await count(ctx.db, schema.projectDocumentFolders), 0, 'submission never initializes business folders');
  const details = ok(await ctx.uc.detail({ ...ctx.command, principalCode: ctx.users.member.code, code: batch.code }));
  assert.equal(details.can_edit, true); assert.equal(details.can_review, false);
  assert.equal(ok(await ctx.uc.context(ctx.command)).repositories[0].code, ctx.repo.code);
  assert.equal(ok(await ctx.uc.list(ctx.command)).batches.length, 1);
});

test('candidate reads and writes reject viewers, outsiders and global administrators without project access', async () => {
  const ctx = await seeded(), batch = await draft(ctx);
  for (const principalCode of [ctx.users.viewer.code, ctx.systemAdmin.code]) {
    for (const result of [await ctx.uc.list({ ...ctx.command, principalCode }), await ctx.uc.context({ ...ctx.command, principalCode }),
      await ctx.uc.detail({ ...ctx.command, principalCode, code: batch.code }),
      await ctx.uc.submit({ ...ctx.command, principalCode, bundle: ctx.bundle, idempotencyKey: 'forbidden' })]) bad(result);
  }
  bad(await ctx.uc.review({ ...ctx.command, principalCode: ctx.users.member.code, code: batch.code, input: { base_revision: batch.revision,
    decisions: batch.items.map(({ item }) => ({ key: item.key, action: 'create' })) } }), 'project_forbidden');
  const frozen = await reviewed(ctx, batch);
  bad(await ctx.uc.apply({ ...ctx.command, principalCode: ctx.users.member.code, code: batch.code, input: { plan_hash: frozen.plan_hash, idempotency_key: 'member' } }), 'project_forbidden');
  await ctx.db.delete(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.member.id)));
  bad(await ctx.uc.detail({ ...ctx.command, principalCode: ctx.users.member.code, code: batch.code }), 'project_forbidden');
});

test('manifest mismatch, invalid references, unsafe paths, credentials and oversized packages fail before persistence', async () => {
  const ctx = await seeded();
  const variants = [
    { ...ctx.bundle, schema_version: 2 },
    { ...ctx.bundle, source: { ...ctx.bundle.source, manifest_sha256: '0'.repeat(64) } },
    { ...ctx.bundle, items: [candidate('bad', 'feature', { module_key: 'missing' })] },
    { ...ctx.bundle, source: { ...ctx.bundle.source, files: [{ path: '../outside', sha256: files[0].sha256 }] } },
    { ...ctx.bundle, items: [candidate('bad', 'module', { content_markdown: '-----BEGIN PRIVATE KEY-----' })] },
    { ...ctx.bundle, items: [candidate('bad', 'module', { content_markdown: 'x'.repeat(11 * 1024 * 1024) })] },
  ];
  for (const bundle of variants) bad(await ctx.uc.submit({ ...ctx.command, bundle, idempotencyKey: 'invalid' }), 'intake_invalid');
  assert.equal(await count(ctx.db, schema.intakeBatches), 0);
});

test('submit idempotency is payload-bound and replacement invalidates old frozen plans', async () => {
  const ctx = await seeded(), batch = await draft(ctx);
  assert.equal((await draft(ctx)).code, batch.code);
  const changed = structuredClone(ctx.bundle); changed.items[0].title = 'Changed title';
  bad(await ctx.uc.submit({ ...ctx.command, principalCode: ctx.users.member.code, bundle: changed, idempotencyKey: 'submit' }), 'intake_conflict');
  const frozen = await reviewed(ctx, batch);
  bad(await ctx.uc.replace({ ...ctx.command, principalCode: ctx.users.member.code, code: batch.code, baseRevision: frozen.revision, bundle: changed }), 'intake_forbidden');
  const replaced = ok(await ctx.uc.replace({ ...ctx.command, code: batch.code, baseRevision: frozen.revision, bundle: changed }));
  assert.equal(replaced.plan_hash, null); assert.equal(replaced.status, 'draft');
  bad(await publish(ctx, frozen), 'intake_conflict');
  bad(await ctx.uc.review({ ...ctx.command, code: batch.code, input: { base_revision: frozen.revision, decisions: batch.items.map(({ item }) => ({ key: item.key, action: 'create' })) } }), 'intake_conflict');
});

test('review requires a decision for every item and rejects dependencies that are skipped', async () => {
  const ctx = await seeded(), batch = await draft(ctx);
  const input = { base_revision: batch.revision, decisions: batch.items.map(({ item }) => ({ key: item.key, action: item.kind === 'module' ? 'skip' : 'create' })) };
  bad(await ctx.uc.review({ ...ctx.command, code: batch.code, input }), 'intake_conflict');
  bad(await ctx.uc.review({ ...ctx.command, code: batch.code, input: { ...input, decisions: input.decisions.slice(1) } }), 'intake_invalid');
  bad(await ctx.uc.apply({ ...ctx.command, code: batch.code, input: { plan_hash: '0'.repeat(64), idempotency_key: 'no-review' } }), 'intake_conflict');
  assert.equal(await count(ctx.db, schema.projectModules), 0);
  assert.equal(await count(ctx.db, schema.projectDocumentFolders), 0, 'invalid plans do not initialize folders');
});

test('reviewed publishing creates all five kinds with first versions, audit, bindings, and draft requirements', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  const published = ok(await publish(ctx, frozen));
  assert.equal(published.status, 'applied'); assert.equal(published.applied_count, 5);
  assert(published.items.every(item => item.status === 'applied' && item.target_code));
  for (const table of [schema.projectModules, schema.features, schema.requirements, schema.requirementDocuments, schema.architectureDocuments,
    schema.requirementRevisions, schema.requirementDocumentRevisions, schema.architectureDocumentRevisions]) assert.equal(await count(ctx.db, table), 1);
  assert.equal((await ctx.db.select().from(schema.requirements))[0].state, 'draft');
  assert.equal((await ctx.db.select().from(schema.requirementDocumentRevisions))[0].summary, 'guide', 'empty summary has explicit title fallback');
  assert.equal(await count(ctx.db, schema.intakeBindings), 5);
  const [attempt] = await ctx.db.select().from(schema.intakeAttempts);
  assert.equal(attempt.status, 'completed'); assert.equal(JSON.parse(attempt.results_json).length, 5);
  assert.equal((await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'intake.item_published'))).length, 5);
  assert.equal(await count(ctx.db, schema.tasks), 0, 'intake never completes or creates execution tasks');
  assert.equal(ok(await publish(ctx, frozen)).status, 'applied');
  assert.equal(await count(ctx.db, schema.projectModules), 1);
  bad(await ctx.uc.apply({ ...ctx.command, code: frozen.code, input: { plan_hash: '0'.repeat(64), idempotency_key: 'apply' } }), 'intake_conflict');
});

test('concurrent retries of the same request both succeed without duplicate entities or bindings', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  const results = await Promise.all([publish(ctx, frozen), publish(ctx, frozen)]);
  for (const result of results) assert.equal(ok(result).status, 'applied');
  assert.equal(await count(ctx.db, schema.projectModules), 1); assert.equal(await count(ctx.db, schema.intakeBindings), 5);
  const final = ok(await ctx.uc.detail({ ...ctx.command, code: frozen.code })); assert.equal(final.status, 'applied');
});

test('different request keys have exactly one publishing winner and only an explicit conflict loser', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  const results = await Promise.all([publish(ctx, frozen, 'first'), publish(ctx, frozen, 'second')]);
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  for (const result of results) if (result.ok) assert.equal(result.data.status, 'applied'); else bad(result, 'intake_conflict');
  assert.equal(await count(ctx.db, schema.projectModules), 1); assert.equal(await count(ctx.db, schema.intakeBindings), 5);
});

test('material fence contention releases governance rows before retrying against an ordinary writer', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  const blocker = await ctx.db.$client.connect();
  const originalTransaction = ctx.db.transaction.bind(ctx.db), dialect = new PgDialect();
  let sawTry, continueTry;
  const reachedTry = new Promise(resolve => { sawTry = resolve; });
  const resumeTry = new Promise(resolve => { continueTry = resolve; });
  let intercept = true, running;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(1094930512::bigint)');
    ctx.db.transaction = (fn, ...args) => originalTransaction(tx => {
      const execute = tx.execute.bind(tx);
      tx.execute = async statement => {
        if (intercept && dialect.sqlToQuery(statement).sql.includes('pg_try_advisory_xact_lock')) {
          intercept = false; sawTry(); await resumeTry;
        }
        return execute(statement);
      };
      return fn(tx);
    }, ...args);
    running = publish(ctx, frozen);
    await Promise.race([reachedTry, delay(3000).then(() => { throw new Error('nonblocking material-fence check was not reached'); })]);
    // This writer holds the material fence and now needs the actor row currently held by intake.
    const actorLock = blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [String(ctx.users.owner.id)]);
    continueTry();
    await actorLock;
    await blocker.query('COMMIT');
    assert.equal(ok(await running).status, 'applied');
    assert.equal(await count(ctx.db, schema.intakeBindings), 5);
  } finally {
    continueTry?.(); await blocker.query('ROLLBACK'); blocker.release();
    if (running) await running;
    ctx.db.transaction = originalTransaction;
  }
});

test('serialization failures in a savepoint retry the whole item transaction without recording a business failure', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  await ctx.db.execute(sql.raw(`CREATE SEQUENCE intake_test_serialization_seq;
    CREATE FUNCTION intake_test_serialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='module' AND nextval('intake_test_serialization_seq')=1 THEN RAISE SQLSTATE '40001' USING MESSAGE='simulated serialization retry'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER intake_test_serialization BEFORE INSERT ON intake_bindings FOR EACH ROW EXECUTE FUNCTION intake_test_serialization();`));
  try {
    const published = ok(await publish(ctx, frozen));
    assert.equal(published.status, 'applied'); assert(published.items.every(row => row.status === 'applied' && row.error === null));
    assert.equal(await count(ctx.db, schema.projectModules), 1); assert.equal(await count(ctx.db, schema.intakeBindings), 5);
    const [attempt] = await ctx.db.select().from(schema.intakeAttempts);
    assert.equal(JSON.parse(attempt.results_json).length, 5);
  } finally { await ctx.db.execute(sql.raw('DROP TRIGGER intake_test_serialization ON intake_bindings; DROP FUNCTION intake_test_serialization(); DROP SEQUENCE intake_test_serialization_seq;')); }
});

test('a busy material fence returns a bounded retry response and preserves the running attempt for the same key', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  const blocker = await ctx.db.$client.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(1094930512::bigint)');
    bad(await publish(ctx, frozen), 'intake_conflict');
    const current = ok(await ctx.uc.detail({ ...ctx.command, code: frozen.code }));
    assert.equal(current.status, 'applying'); assert.equal(current.stop_requested, false);
    assert(current.items.every(row => row.status === 'pending' && row.error === null));
    assert.equal((await ctx.db.select().from(schema.intakeAttempts))[0].status, 'running');
    await blocker.query('COMMIT');
    assert.equal(ok(await publish(ctx, frozen)).status, 'applied');
    assert.equal(await count(ctx.db, schema.intakeAttempts), 1);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('cross-batch source identity requires explicit same-target binding and preserves existing revisions', async () => {
  const ctx = await seeded(), original = ok(await publish(ctx, await reviewed(ctx, await draft(ctx))));
  const next = await draft(ctx, 'second');
  bad(await ctx.uc.review({ ...ctx.command, code: next.code, input: { base_revision: next.revision, decisions: next.items.map(({ item }) => ({ key: item.key, action: 'create' })) } }), 'intake_conflict');
  const decisions = next.items.map(row => ({ key: row.item.key, action: 'bind', target_code: row.existing_binding.code, target_fingerprint: row.existing_binding.fingerprint }));
  const published = ok(await publish(ctx, await reviewed(ctx, next, decisions), 'bind'));
  assert(published.items.every(row => row.status === 'bound'));
  assert.deepEqual(published.items.map(row => row.target_code), original.items.map(row => row.target_code));
  assert.equal(await count(ctx.db, schema.intakeBindings), 5); assert.equal(await count(ctx.db, schema.requirementRevisions), 1);
});

test('binding fingerprints detect metadata changes and candidate parents must match the existing hierarchy', async () => {
  const ctx = await seeded(), original = ok(await publish(ctx, await reviewed(ctx, await draft(ctx))));
  const next = await draft(ctx, 'second');
  const decisions = next.items.map(row => ({ key: row.item.key, action: 'bind', target_code: row.existing_binding.code, target_fingerprint: row.existing_binding.fingerprint }));
  const frozen = await reviewed(ctx, next, decisions);
  await ctx.db.update(schema.projectModules).set({ name: 'Edited after review' }).where(eq(schema.projectModules.code, original.items.find(row => row.item.kind === 'module').target_code));
  bad(await publish(ctx, frozen, 'stale'), 'intake_conflict');
  assert.equal(await count(ctx.db, schema.intakeAttempts), 1, 'stale plan never starts another attempt');
  assert.equal(await count(ctx.db, schema.intakeBindings), 5);
});

test('projects and repositories cannot be mixed and context exposes only current project resources', async () => {
  const ctx = await seeded();
  const other = await seedWorkspaceProject(ctx.db, { teamLegacyCode: 'OTHER', projectLegacyCode: 'OTHER', users: [
    { key: 'owner', account: 'other', displayName: 'Other', projectRole: 'owner' },
  ] });
  const [repo] = await ctx.db.insert(schema.projectRepositories).values({ project_id: other.project.id, name: 'Private repo', remote_url: 'https://example.test/private.git',
    created_by: other.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  bad(await ctx.uc.submit({ ...ctx.command, bundle: { ...ctx.bundle, repository_code: repo.code }, idempotencyKey: 'cross' }), 'intake_invalid');
  bad(await ctx.uc.submit({ ...ctx.command, bundle: { ...ctx.bundle, project_code: other.project.code }, idempotencyKey: 'cross' }), 'intake_invalid');
  const projection = ok(await ctx.uc.context(ctx.command)); assert.deepEqual(projection.repositories.map(row => row.name), ['Source']);
  const batch = await draft(ctx);
  bad(await ctx.uc.detail({ projectCode: other.project.code, principalCode: other.users.owner.code, code: batch.code }), 'intake_not_found');
});

test('item failures roll back entity, version, audit and binding together; failed dependencies do not create implicit modules', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  await ctx.db.execute(sql.raw(`CREATE FUNCTION intake_test_reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='module' THEN RAISE EXCEPTION 'injected interruption'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER intake_test_reject_binding BEFORE INSERT ON intake_bindings FOR EACH ROW EXECUTE FUNCTION intake_test_reject_binding();`));
  let partial;
  try {
    partial = ok(await publish(ctx, frozen));
    assert.equal(partial.status, 'partial');
    assert.equal(partial.items.find(row => row.item.kind === 'module').status, 'failed');
    assert(partial.items.filter(row => ['feature', 'requirement_document', 'requirement'].includes(row.item.kind)).every(row => row.status === 'blocked'));
    assert.equal(await count(ctx.db, schema.projectModules), 0); assert.equal(await count(ctx.db, schema.requirementDocuments), 0);
    assert.equal((await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entity_type, 'project_module'))).length, 0);
    assert.equal(await count(ctx.db, schema.intakeBindings), 1, 'independent architecture is committed');
  } finally { await ctx.db.execute(sql.raw('DROP TRIGGER intake_test_reject_binding ON intake_bindings; DROP FUNCTION intake_test_reject_binding();')); }
  ctx.uc = createIntakeUseCases(ctx.db);
  assert.equal(ok(await publish(ctx, frozen)).status, 'partial', 'old key only replays completed attempt');
  assert.equal(await count(ctx.db, schema.projectModules), 0);
  const done = ok(await publish(ctx, partial, 'resume'));
  assert.equal(done.status, 'applied'); assert.equal(await count(ctx.db, schema.intakeBindings), 5);
  assert.equal(await count(ctx.db, schema.architectureDocuments), 1, 'successful earlier item is never rerun');
});

test('stop is durable across service recreation; old request keys cannot resume, new explicit attempts can', async () => {
  const ctx = await seeded();
  ctx.bundle.items = Array.from({ length: 12 }, (_, n) => candidate(`module-${n}`, 'module'));
  const frozen = await reviewed(ctx, await draft(ctx));
  await ctx.db.execute(sql.raw(`CREATE FUNCTION intake_test_slow_module() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$;
    CREATE TRIGGER intake_test_slow_module BEFORE INSERT ON project_modules FOR EACH ROW EXECUTE FUNCTION intake_test_slow_module();`));
  try {
    const running = publish(ctx, frozen);
    for (let n = 0; n < 100 && await count(ctx.db, schema.projectModules) === 0; n++) await delay(10);
    const stopped = ok(await ctx.uc.stop({ ...ctx.command, code: frozen.code, baseRevision: frozen.revision }));
    await running;
    assert.equal(stopped.stop_requested, true); assert.equal(stopped.status, 'partial');
    const number = await count(ctx.db, schema.projectModules); assert(number > 0 && number < 12);
    ctx.uc = createIntakeUseCases(ctx.db);
    assert.equal(ok(await publish(ctx, frozen)).stop_requested, true); assert.equal(await count(ctx.db, schema.projectModules), number);
    const done = ok(await publish(ctx, stopped, 'explicit-resume')); assert.equal(done.status, 'applied');
    assert.equal(await count(ctx.db, schema.projectModules), 12);
  } finally { await ctx.db.execute(sql.raw('DROP TRIGGER intake_test_slow_module ON project_modules; DROP FUNCTION intake_test_slow_module();')); }
});

test('revocation and archival are checked again before publishing, while archive keeps history readable', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  await ctx.db.update(schema.members).set({ role: 'member' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.owner.id)));
  bad(await publish(ctx, frozen), 'project_forbidden');
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  const archived = ok(await ctx.uc.detail({ ...ctx.command, code: frozen.code }));
  assert.equal(archived.can_edit, false); assert.equal(archived.can_review, false);
  assert.equal(ok(await ctx.uc.list(ctx.command)).can_submit, false);
  bad(await ctx.uc.apply({ ...ctx.command, principalCode: ctx.users.admin.code, code: frozen.code, input: { plan_hash: frozen.plan_hash, idempotency_key: 'archive' } }), 'project_archived');
  assert.equal(await count(ctx.db, schema.projectModules), 0);
});

test('completed candidates and their evidence cannot be rewritten by partial-batch replacement', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  const done = ok(await publish(ctx, frozen));
  const changed = structuredClone(ctx.bundle); changed.items[0].title = 'Rewrite';
  bad(await ctx.uc.replace({ ...ctx.command, code: done.code, baseRevision: done.revision, bundle: changed }), 'intake_conflict');
});

test('binding an existing child under a different candidate module is rejected without writes', async () => {
  const ctx = await seeded();
  await publish(ctx, await reviewed(ctx, await draft(ctx)));
  const [otherModule] = await ctx.db.insert(schema.projectModules).values({ project_id: ctx.project.id, name: 'Other module', created_at: 't0', updated_at: 't0' }).returning();
  const [otherFeature] = await ctx.db.insert(schema.features).values({ project_id: ctx.project.id, module_id: otherModule.id, title: 'Other feature' }).returning();
  ctx.bundle.namespace = 'fresh';
  const next = await draft(ctx, 'mismatch');
  const targets = ok(await ctx.uc.context(ctx.command)).targets;
  const module = targets.find(row => row.kind === 'module' && row.title === 'auth');
  const feature = targets.find(row => row.code === otherFeature.code);
  const decisions = next.items.map(({ item }) => item.key === 'auth' ? { key: item.key, action: 'bind', target_code: module.code, target_fingerprint: module.fingerprint }
    : item.key === 'login' ? { key: item.key, action: 'bind', target_code: feature.code, target_fingerprint: feature.fingerprint } : { key: item.key, action: 'skip' });
  bad(await ctx.uc.review({ ...ctx.command, code: next.code, input: { base_revision: next.revision, decisions } }), 'intake_conflict');
  assert.equal(await count(ctx.db, schema.intakeBindings), 5);
});

test('revoking the publishing actor between items stops further writes and persists partial facts', async () => {
  const ctx = await seeded();
  ctx.bundle.items = Array.from({ length: 12 }, (_, n) => candidate(`module-${n}`, 'module'));
  const frozen = await reviewed(ctx, await draft(ctx));
  await ctx.db.execute(sql.raw(`CREATE FUNCTION intake_test_revoke_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$;
    CREATE TRIGGER intake_test_revoke_delay BEFORE INSERT ON project_modules FOR EACH ROW EXECUTE FUNCTION intake_test_revoke_delay();`));
  try {
    const running = publish(ctx, frozen);
    for (let n = 0; n < 100 && await count(ctx.db, schema.projectModules) === 0; n++) await delay(10);
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.owner.id));
    bad(await running, 'project_forbidden');
    const number = await count(ctx.db, schema.projectModules); assert(number > 0 && number < 12);
    const current = ok(await ctx.uc.detail({ ...ctx.command, principalCode: ctx.users.admin.code, code: frozen.code }));
    assert.equal(current.status, 'partial'); assert.equal(current.stop_requested, true);
    assert.equal((await ctx.db.select().from(schema.intakeAttempts))[0].status, 'stopped');
    assert.equal(await count(ctx.db, schema.intakeBindings), number, 'every committed entity has its mapping');
  } finally { await ctx.db.execute(sql.raw('DROP TRIGGER intake_test_revoke_delay ON project_modules; DROP FUNCTION intake_test_revoke_delay();')); }
});

test('an interrupted running attempt recovers from durable item receipts after service recreation', async () => {
  const ctx = await seeded(), frozen = await reviewed(ctx, await draft(ctx));
  await ctx.db.execute(sql.raw(`CREATE FUNCTION intake_test_crash_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='module' THEN RAISE EXCEPTION 'failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER intake_test_crash_boundary BEFORE INSERT ON intake_bindings FOR EACH ROW EXECUTE FUNCTION intake_test_crash_boundary();`));
  try { assert.equal(ok(await publish(ctx, frozen)).status, 'partial'); }
  finally { await ctx.db.execute(sql.raw('DROP TRIGGER intake_test_crash_boundary ON intake_bindings; DROP FUNCTION intake_test_crash_boundary();')); }
  // Recreate a durable crash boundary: independent item committed, remaining items unclaimed, attempt still running.
  const [batch] = await ctx.db.select().from(schema.intakeBatches);
  await ctx.db.update(schema.intakeBatches).set({ status: 'applying' }).where(eq(schema.intakeBatches.id, batch.id));
  await ctx.db.update(schema.intakeAttempts).set({ status: 'running', finished_at: null }).where(eq(schema.intakeAttempts.batch_id, batch.id));
  for (const state of ['failed', 'blocked']) await ctx.db.update(schema.intakeItems).set({ status: 'pending', error: null }).where(and(eq(schema.intakeItems.batch_id, batch.id), eq(schema.intakeItems.status, state)));
  ctx.uc = createIntakeUseCases(ctx.db);
  const done = ok(await publish(ctx, frozen));
  assert.equal(done.status, 'applied'); assert.equal(await count(ctx.db, schema.architectureDocuments), 1);
  assert.equal(await count(ctx.db, schema.intakeBindings), 5);
});

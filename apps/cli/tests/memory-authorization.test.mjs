import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryAuthorizationLedger, memoryOperationDigest } from '../dist/memory-authorization.js';

const operation = () => ({
  account: 'member-alice', project: 'project-a', session: 'chat-a', operation: 'git_push',
  repo: 'F:/workspace/project-a', remote: 'ssh://git.test/project-a.git',
  branch: 'refs/heads/dev', commit: 'a'.repeat(40),
});
const confirmed = (ledger, scope = operation(), event = 'human-turn-1', expiresAt = 2000) =>
  ledger.confirm({ ...scope, confirmation: { id: event, source: 'human' }, expiresAt });

test('a remembered habit cannot create a one-time action grant and each target field is bound', async () => {
  const ledger = createMemoryAuthorizationLedger({ now: () => 1000 });
  assert.throws(() => ledger.confirm({ ...operation(), confirmation: { id: 'memory', source: 'memory' }, expiresAt: 2000 }),
    { code: 'memory_confirmation_required' });
  const grant = confirmed(ledger);
  let effects = 0;
  for (const changed of [
    { account: 'bob' }, { project: 'project-b' }, { session: 'chat-b' },
    { repo: 'F:/workspace/project-b' }, { remote: 'ssh://git.test/other.git' },
    { branch: 'refs/heads/main' }, { commit: 'b'.repeat(40) },
  ]) {
    await assert.rejects(ledger.executeOnce({ ...operation(), ...changed, grantId: grant.grantId }, () => effects++),
      { code: 'memory_authorization_scope_mismatch' });
  }
  assert.equal(effects, 0);
  assert.equal(ledger.inspect(grant.grantId).status, 'active');
  assert.equal(memoryOperationDigest(operation()), grant.operationDigest);
});

test('concurrent requests can perform only one effect', async () => {
  const ledger = createMemoryAuthorizationLedger({ now: () => 1000 });
  const grant = confirmed(ledger);
  let effects = 0;
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const first = ledger.executeOnce({ ...operation(), grantId: grant.grantId }, async () => {
    effects++;
    await waiting;
    return 'completed';
  });
  await assert.rejects(ledger.executeOnce({ ...operation(), grantId: grant.grantId }, () => effects++),
    { code: 'memory_authorization_used' });
  finish();
  assert.equal(await first, 'completed');
  assert.equal(effects, 1);
});

test('an uncertain or failed effect consumes its permission before a retry', async () => {
  const ledger = createMemoryAuthorizationLedger({ now: () => 1000 });
  const grant = confirmed(ledger);
  let effects = 0;
  await assert.rejects(ledger.executeOnce({ ...operation(), grantId: grant.grantId }, () => {
    effects++;
    throw Error('transport outcome unknown');
  }), /outcome unknown/);
  await assert.rejects(ledger.executeOnce({ ...operation(), grantId: grant.grantId }, () => effects++),
    { code: 'memory_authorization_used' });
  assert.equal(effects, 1);
  const replayed = confirmed(ledger);
  assert.equal(replayed.grantId, grant.grantId);
  assert.equal(replayed.status, 'used');
  assert.throws(() => confirmed(ledger, { ...operation(), branch: 'main' }), { code: 'memory_confirmation_conflict' });
  assert.throws(() => confirmed(ledger, operation(), 'human-turn-1', 3000), { code: 'memory_confirmation_conflict' });
});

test('expiry, revocation, session invalidation and adapter restart require a fresh confirmation', async () => {
  let time = 1000;
  const ledger = createMemoryAuthorizationLedger({ now: () => time });
  const expired = confirmed(ledger, operation(), 'expires');
  const revoked = confirmed(ledger, operation(), 'revoked');
  const other = { ...operation(), project: 'project-b' };
  const keep = confirmed(ledger, other, 'keep');
  assert.equal(ledger.revoke(revoked.grantId), true);
  assert.equal(ledger.revoke(revoked.grantId), false);
  await assert.rejects(ledger.executeOnce({ ...operation(), grantId: revoked.grantId }, () => assert.fail()),
    { code: 'memory_authorization_revoked' });
  time = 2000;
  await assert.rejects(ledger.executeOnce({ ...operation(), grantId: expired.grantId }, () => assert.fail()),
    { code: 'memory_authorization_expired' });
  assert.equal(confirmed(ledger, operation(), 'expires').status, 'expired');
  time = 1000;
  const invalidated = confirmed(ledger, operation(), 'session-close');
  assert.equal(ledger.invalidateSession({ account: 'member-alice', project: 'project-a', session: 'chat-a' }), 1);
  assert.equal(ledger.inspect(invalidated.grantId).status, 'revoked');
  assert.equal(ledger.inspect(keep.grantId).status, 'active');
  const restarted = createMemoryAuthorizationLedger({ now: () => 1000 });
  await assert.rejects(restarted.executeOnce({ ...other, grantId: keep.grantId }, () => assert.fail()),
    { code: 'memory_authorization_missing' });
});

test('confirmation and inspection values cannot mutate the stored scope or regenerate a consumed grant', () => {
  const ledger = createMemoryAuthorizationLedger({ now: () => 1000, maxGrants: 1 });
  const scope = operation();
  const grant = confirmed(ledger, scope);
  scope.project = 'changed';
  grant.grantId = 'fabricated';
  const actual = confirmed(ledger);
  const view = ledger.inspect(actual.grantId);
  view.status = 'revoked';
  ledger.consume({ ...operation(), grantId: actual.grantId });
  assert.equal(ledger.inspect(actual.grantId).usesRemaining, 0);
  assert.throws(() => confirmed(ledger, operation(), 'new-event'), { code: 'memory_authorization_capacity' });
});

test('invalid bindings and expired new confirmations fail before any grant is created', () => {
  const ledger = createMemoryAuthorizationLedger({ now: () => 1000 });
  for (const changed of [
    { account: '' }, { project: ' leading-space' }, { session: 'chat\nother' },
    { operation: 'git_delete' }, { repo: '' }, { remote: '' }, { branch: 'dev\0other' },
    { commit: 'HEAD' }, { commit: 'a'.repeat(39) }, { commit: 'A'.repeat(40) },
  ]) {
    assert.throws(() => confirmed(ledger, { ...operation(), ...changed }), { code: 'memory_authorization_invalid' });
  }
  for (const deadline of [1000, 999, Number.NaN, Infinity, 1000.5]) {
    assert.throws(() => confirmed(ledger, operation(), 'new-expired', deadline), { code: 'memory_authorization_invalid' });
  }
  assert.equal(confirmed(ledger).status, 'active');
});

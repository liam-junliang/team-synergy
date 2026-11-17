import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@team-synergy/domain';

export interface MemoryActionScope {
  account: string;
  project: string;
  session: string;
}

export interface MemoryPushOperation extends MemoryActionScope {
  operation: 'git_push';
  repo: string;
  remote: string;
  branch: string;
  commit: string;
}

export interface MemoryHumanConfirmation {
  id: string;
  source: 'human';
}

type GrantStatus = 'active' | 'used' | 'revoked' | 'expired';
type StoredGrant = {
  grantId: string;
  operationDigest: string;
  scope: MemoryActionScope;
  expiresAt: number;
  status: GrantStatus;
};

const invalid = () => new DomainError('memory_authorization_invalid', '动作许可的绑定或有效期无效。');

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    value === value.trim() && !/\p{Cc}/u.test(value);
}

function validateScope(scope: MemoryActionScope) {
  if (!scope || ![scope.account, scope.project, scope.session].every(nonempty)) throw invalid();
}

/** The adapter resolves repository and remote identities before requesting a
 * confirmation. This digest binds those exact identities and the commit payload. */
export function memoryOperationDigest(operation: MemoryPushOperation): string {
  validateScope(operation);
  if (operation.operation !== 'git_push' || ![operation.repo, operation.remote, operation.branch].every(nonempty) ||
      typeof operation.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(operation.commit)) {
    throw invalid();
  }
  return createHash('sha256').update(JSON.stringify([
    operation.account, operation.project, operation.session, operation.operation,
    operation.repo, operation.remote, operation.branch, operation.commit,
  ])).digest('hex');
}

/** A process-local capability ledger for a trusted harness adapter.
 * confirm/revoke belong to its human-control channel, never its model tools.
 * The ledger is intentionally absent from the long-term memory write path. */
export function createMemoryAuthorizationLedger(options: { now?: () => number; maxGrants?: number } = {}) {
  const now = options.now ?? Date.now;
  const capacity = options.maxGrants ?? 256;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw invalid();
  const grants = new Map<string, StoredGrant>();
  const confirmations = new Map<string, StoredGrant>();

  function status(grant: StoredGrant): GrantStatus {
    if (grant.status === 'active' && now() >= grant.expiresAt) grant.status = 'expired';
    return grant.status;
  }

  function confirm(input: MemoryPushOperation & { confirmation: MemoryHumanConfirmation; expiresAt: number }) {
    const digest = memoryOperationDigest(input);
    if (!input.confirmation || input.confirmation.source !== 'human' || !nonempty(input.confirmation.id)) {
      throw new DomainError('memory_confirmation_required', '该动作需要当前操作者明确确认。');
    }
    if (!Number.isSafeInteger(input.expiresAt)) throw invalid();
    const previous = confirmations.get(input.confirmation.id);
    if (previous) {
      if (previous.operationDigest !== digest || previous.expiresAt !== input.expiresAt) {
        throw new DomainError('memory_confirmation_conflict', '同一确认事件已绑定其他动作。');
      }
      return { grantId: previous.grantId, operationDigest: digest, expiresAt: previous.expiresAt, status: status(previous) };
    }
    if (input.expiresAt <= now()) throw invalid();
    // Retain consumed confirmation IDs until this ledger ends, so a replay
    // cannot silently recreate a previously exhausted authorization.
    if (grants.size >= capacity) {
      throw new DomainError('memory_authorization_capacity', '当前会话的许可记录已满，请由操作者开启新的受控会话。');
    }
    const grantId = randomUUID();
    const grant: StoredGrant = {
      grantId, operationDigest: digest,
      scope: { account: input.account, project: input.project, session: input.session },
      expiresAt: input.expiresAt, status: 'active',
    };
    grants.set(grantId, grant);
    confirmations.set(input.confirmation.id, grant);
    return { grantId, operationDigest: digest, expiresAt: input.expiresAt, status: 'active' as const };
  }

  function consume(input: MemoryPushOperation & { grantId: string }) {
    const digest = memoryOperationDigest(input);
    const grant = grants.get(input.grantId);
    if (!grant) throw new DomainError('memory_authorization_missing', '当前会话没有可用的动作许可。');
    if (grant.operationDigest !== digest) {
      throw new DomainError('memory_authorization_scope_mismatch', '动作目标或会话已变化，需要重新确认。');
    }
    const current = status(grant);
    if (current !== 'active') {
      throw new DomainError('memory_authorization_' + current, '动作许可已使用、已撤销或已过期，需要重新确认。');
    }
    // Consume before the effect begins. A failure or uncertain remote result
    // must not make an old human confirmation reusable.
    grant.status = 'used';
    return { authorized: true as const, grantId: grant.grantId, operationDigest: grant.operationDigest };
  }

  async function executeOnce<T>(input: MemoryPushOperation & { grantId: string },
      action: (permit: ReturnType<typeof consume>) => Promise<T> | T): Promise<T> {
    const permit = consume(input);
    return action(permit);
  }

  function revoke(grantId: string) {
    const grant = grants.get(grantId);
    if (!grant || status(grant) !== 'active') return false;
    grant.status = 'revoked';
    return true;
  }

  function invalidateSession(scope: MemoryActionScope) {
    validateScope(scope);
    let count = 0;
    for (const grant of grants.values()) {
      if (grant.scope.account === scope.account && grant.scope.project === scope.project &&
          grant.scope.session === scope.session && revoke(grant.grantId)) count++;
    }
    return count;
  }

  function inspect(grantId: string) {
    const grant = grants.get(grantId);
    if (!grant) return null;
    const current = status(grant);
    return { grantId: grant.grantId, operationDigest: grant.operationDigest, expiresAt: grant.expiresAt,
      status: current, usesRemaining: current === 'active' ? 1 : 0 };
  }

  return { confirm, consume, executeOnce, revoke, invalidateSession, inspect };
}

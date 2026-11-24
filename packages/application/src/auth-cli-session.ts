import { createHmac } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { CLI_ACCESS_TTL_MS, equalHash, parseDeviceIdentity, type AuthDb, type StoredDeviceIdentity } from './auth-device.js';
import { hashToken } from './user-use-cases.js';

const tokenPattern = /^[a-f0-9]{64}$/;
const retryWindowMs = 5 * 60_000;
const previousAccessGraceMs = 15_000;
const sessions = schema.deviceSessions;
const { runLeases, runs } = schema;
type Session = typeof sessions.$inferSelect;

function cliProof(input: unknown): StoredDeviceIdentity | undefined {
  try {
    const proof = parseDeviceIdentity(input);
    return proof?.client_type === 'cli' ? proof : undefined;
  } catch { return undefined; }
}

function derive(token: string, label: string, context: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(label + '\0' + context).digest('hex');
}

/** Password changes, device revocation and session refresh share a stable lock order. */
async function authorizedSession(tx: AuthDb, candidate: Session, proof: StoredDeviceIdentity) {
  const [owner] = await tx.select({ id: schema.devices.principal_id }).from(schema.devices)
    .where(eq(schema.devices.id, candidate.device_id)).limit(1);
  if (!owner) return;
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, owner.id)).for('update').limit(1);
  if (!user || user.status !== 'active' || user.must_change_password) return;
  const [device] = await tx.select().from(schema.devices).where(and(eq(schema.devices.id, candidate.device_id),
    eq(schema.devices.principal_id, user.id))).for('update').limit(1);
  if (!device || device.client_type !== 'cli' || device.revoked_at || device.installation_id !== proof.installation_id
    || !equalHash(device.installation_secret_hash, proof.installation_secret_hash)) return;
  const [session] = await tx.select().from(sessions).where(eq(sessions.id, candidate.id)).for('update').limit(1);
  if (!session?.expires_at || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) return;
  return { session, device, user, expiresAt: session.expires_at };
}

function credentials(access: string, refresh: string, accessExpiry: string, session: Session, expiresAt: string) {
  return { device_token: access, refresh_token: refresh, session_code: session.code,
    access_expires_at: accessExpiry, session_expires_at: expiresAt, last_refreshed_at: session.last_refreshed_at };
}

export async function upgradeCliDeviceSession(db: Db, access: string, identity: unknown) {
  const proof = cliProof(identity);
  if (!proof || !tokenPattern.test(access)) return null;
  const hash = hashToken(access);
  const [candidate] = await db.select().from(sessions).where(eq(sessions.token_hash, hash)).limit(1);
  if (!candidate) return null;
  return db.transaction(async tx => {
    const auth = await authorizedSession(tx, candidate, proof);
    if (!auth || !equalHash(auth.session.token_hash, hash)) return null;
    const { session, expiresAt } = auth;
    const refresh = derive(access, 'tsp-cli-upgrade-v1', proof.installation_secret_hash);
    const refreshHash = hashToken(refresh);
    if (session.refresh_token_hash) {
      if (!equalHash(session.refresh_token_hash, refreshHash) || !session.access_expires_at || session.last_refreshed_at
        || Date.parse(session.access_expires_at) <= Date.now()) return null;
      return credentials(access, refresh, session.access_expires_at, session, expiresAt);
    }
    // A pre-renewal supervisor keeps the initial token for its entire Run.
    const [liveRun] = await tx.select({ id: runLeases.id }).from(runLeases)
      .innerJoin(runs, and(eq(runs.id, runLeases.run_id), eq(runs.execution_epoch, runLeases.epoch)))
      .where(and(eq(runLeases.device_id, auth.device.id), isNull(runLeases.revoked_at), eq(runs.status, 'active'),
        gt(runLeases.expires_at, new Date().toISOString()))).limit(1);
    if (liveRun) return { deferred: true } as const;
    const accessExpiry = new Date(Math.min(Date.now() + CLI_ACCESS_TTL_MS, Date.parse(expiresAt))).toISOString();
    await tx.update(sessions).set({ refresh_token_hash: refreshHash, access_expires_at: accessExpiry }).where(eq(sessions.id, session.id));
    return credentials(access, refresh, accessExpiry, session, expiresAt);
  });
}

export async function refreshCliDeviceSession(db: Db, refresh: unknown, requestId: unknown, identity: unknown) {
  const proof = cliProof(identity);
  if (!proof || typeof refresh !== 'string' || !tokenPattern.test(refresh)
    || typeof requestId !== 'string' || !tokenPattern.test(requestId)) return null;
  const hash = hashToken(refresh);
  const operation = hashToken(requestId);
  const [candidate] = await db.select().from(sessions).where(or(eq(sessions.refresh_token_hash, hash),
    eq(sessions.previous_refresh_token_hash, hash))).limit(1);
  if (!candidate) return null;

  return db.transaction(async tx => {
    const auth = await authorizedSession(tx, candidate, proof);
    if (!auth) return null;
    const { session, expiresAt } = auth;
    const context = requestId + proof.installation_secret_hash;
    // Reconstruct a lost response only with the same token, proof and durable operation key.
    // The database stores hashes and timestamps, never raw credentials or request keys.
    const access = derive(refresh, 'tsp-cli-access-v1', context);
    const successor = derive(refresh, 'tsp-cli-refresh-v1', context);
    const now = Date.now();
    if (equalHash(session.previous_refresh_token_hash, hash)) {
      if (equalHash(session.refresh_request_id_hash, operation)) {
        if (session.last_refreshed_at && now - Date.parse(session.last_refreshed_at) <= retryWindowMs
          && session.access_expires_at && Date.parse(session.access_expires_at) > now
          && equalHash(session.refresh_token_hash, hashToken(successor)) && equalHash(session.token_hash, hashToken(access))) {
          return credentials(access, successor, session.access_expires_at, session, expiresAt);
        }
        return null;
      }
      await tx.update(sessions).set({ revoked_at: new Date(now).toISOString() }).where(eq(sessions.id, session.id));
      return null;
    }
    if (!equalHash(session.refresh_token_hash, hash)) return null;
    const accessExpiry = new Date(Math.min(now + CLI_ACCESS_TTL_MS, Date.parse(expiresAt))).toISOString();
    const lastRefresh = new Date(now).toISOString();
    // An in-flight caller may have already read the prior, still valid access token.
    const previousExpiry = session.access_expires_at && Date.parse(session.access_expires_at) > now
      ? new Date(Math.min(Date.parse(session.access_expires_at), now + previousAccessGraceMs)).toISOString() : null;
    await tx.update(sessions).set({ token_hash: hashToken(access), access_expires_at: accessExpiry,
      previous_access_token_hash: previousExpiry ? session.token_hash : null, previous_access_expires_at: previousExpiry,
      refresh_token_hash: hashToken(successor), previous_refresh_token_hash: hash, refresh_request_id_hash: operation,
      last_refreshed_at: lastRefresh }).where(eq(sessions.id, session.id));
    return credentials(access, successor, accessExpiry, { ...session, last_refreshed_at: lastRefresh }, expiresAt);
  });
}

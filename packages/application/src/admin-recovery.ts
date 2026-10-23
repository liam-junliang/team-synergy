import { auditLoginUnlock } from './login-security.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { bootstrapPasswordTtlMinutes } from './bootstrap-config.js';
import { hashPassword } from './password-auth.js';
import { normalizeAccount, hashToken } from './user-use-cases.js';
import { revokeStableDevice } from './auth-device.js';
import { createPublicCode } from './public-code.js';
import { fail, insertAudit, now } from './task-service.js';
export { bootstrapPasswordTtlMinutes } from './bootstrap-config.js';

interface AdminRecoveryResult { user_code: string; account: string; expires_at: string; revoked_devices: number }

/** Trusted server-local database operator only; never expose through an HTTP route. */
export async function resetLocalAdminPassword(db: Db, command: {
  account: string; newPassword: string; localOperator: string; localHostname: string;
}) {
  try {
    const account = normalizeAccount(command.account);
    if (!account || command.newPassword.length < 8 || command.newPassword.length > 128) throw new DomainError('admin_recovery_invalid', 'Invalid administrator account or password length');
    if (!command.localOperator.trim() || command.localOperator.length > 256 || !command.localHostname.trim() || command.localHostname.length > 256) throw new DomainError('admin_recovery_invalid', 'Local operator identity is required');
    const ttl = bootstrapPasswordTtlMinutes(process.env.TSP_BOOTSTRAP_TTL_MINUTES);
    const passwordHash = await hashPassword(command.newPassword);
    const data = await db.transaction(async tx => {
      // Recovery is rare maintenance. Approval/redemption lock request rows before
      // users, so fence request mutations BEFORE taking the administrator row.
      // In-flight redemptions finish first and their newly created sessions below
      // are revoked too; approvals cannot appear between the scan and reset.
      await tx.execute(sql`lock table device_authorization_requests in exclusive mode`);
      const [admin] = await tx.select().from(schema.users).where(eq(schema.users.account, account)).for('update').limit(1);
      if (!admin?.is_system_admin || admin.status !== 'active' || admin.deleted_at || admin.pending_deletion) throw new DomainError('admin_recovery_forbidden', 'Only an active platform administrator can be recovered');
      await auditLoginUnlock(tx, admin, 'local_admin_reset');
      const timestamp = now();
      const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
      const revokedAuthorizations = await tx.update(schema.deviceAuthorizationRequests)
        .set({ status: 'denied', expires_at: timestamp })
        .where(and(eq(schema.deviceAuthorizationRequests.principal_id, admin.id),
          inArray(schema.deviceAuthorizationRequests.status, ['pending', 'approved'])))
        .returning({ id: schema.deviceAuthorizationRequests.id });
      await tx.update(schema.users).set({ password_hash: passwordHash, must_change_password: true, password_expires_at: expiresAt,
        login_failure_count: 0, login_locked_until: null, bind_token_hash: null, bind_token_expires_at: null,
      }).where(eq(schema.users.id, admin.id));
      // Revoke all installations, including old ones with surviving sessions/leases.
      const allDevices = await tx.select({ id: schema.devices.id, revoked_at: schema.devices.revoked_at }).from(schema.devices).where(eq(schema.devices.principal_id, admin.id));
      const revokedDevices = allDevices.filter(device => device.revoked_at === null).length;
      for (const device of allDevices) await revokeStableDevice(tx, device.id);
      await tx.delete(schema.authRateLimits).where(eq(schema.authRateLimits.key, hashToken(`password:account:${account}`)));
      const audit = { entity_type: 'user', entity_id: admin.id, principal_id: admin.id, base_snapshot: 0,
        action: 'admin.password_reset', payload: { auth_method: 'local_database_operator', actor_authenticated: false,
          local_operator: command.localOperator, local_hostname: command.localHostname, subject_user_code: admin.code, revoked_devices: revokedDevices, revoked_authorizations: revokedAuthorizations.length },
      };
      // The real subject supplies a valid identity; metadata explicitly distinguishes
      // OS/database authorization from an authenticated administrator session.
      assertAuditedChange(audit);
      await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
      return { user_code: admin.code, account: admin.account, expires_at: expiresAt, revoked_devices: revokedDevices };
    });
    return { ok: true as const, data };
  } catch (error) { return fail<AdminRecoveryResult>(error instanceof DomainError ? error : new DomainError('admin_recovery_failed', 'Administrator recovery failed')); }
}

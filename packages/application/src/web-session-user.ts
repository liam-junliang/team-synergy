import type { Db } from '@team-synergy/persistence';
import { findUserByCode } from './public-code.js';

/** Session presentation deliberately omits all credential/session storage fields. */
export async function getWebSessionUser(db: Db, principalCode: string) {
  const user = await findUserByCode(db, principalCode);
  if (!user || user.status !== 'active' || user.deleted_at) return undefined;
  return { user_code: user.code, account: user.account, display_name: user.display_name,
    status: user.status, is_system_admin: user.is_system_admin, must_change_password: user.must_change_password };
}

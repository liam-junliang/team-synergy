import { eq, lt } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { hashToken } from './user-use-cases.js';

/** Row locks keep quotas correct across processes without any global advisory lock. */
export function createAuthRateLimiter(db: Db) {
  return async (scope: string, ip: string, account: string | undefined, minuteMax = 5, hourMax = 20): Promise<number> => {
    const timestamp = new Date();
    const keys = [`${scope}:ip:${ip}`, ...(account ? [`${scope}:account:${account}`] : [])].map(hashToken).sort();
    return db.transaction(async tx => {
      // Expired rows hold no quota; keep attacker-selected identifiers bounded by retention.
      await tx.delete(schema.authRateLimits).where(lt(schema.authRateLimits.hour_started_at, new Date(timestamp.getTime() - 3_600_000)));
      let retry = 0;
      for (const key of keys) {
        await tx.insert(schema.authRateLimits).values({ key, minute_started_at: timestamp, minute_count: 0, hour_started_at: timestamp, hour_count: 0 }).onConflictDoNothing();
        const [row] = await tx.select().from(schema.authRateLimits).where(eq(schema.authRateLimits.key, key)).for('update');
        if (!row) throw new Error('Authentication quota unavailable');
        const minuteExpired = timestamp.getTime() - row.minute_started_at.getTime() >= 60_000;
        const minuteCount = minuteExpired ? 0 : row.minute_count;
        if (minuteCount >= minuteMax) retry = Math.max(retry, Math.ceil((row.minute_started_at.getTime() + 60_000 - timestamp.getTime()) / 1000));
        if (row.hour_count >= hourMax) retry = Math.max(retry, Math.ceil((row.hour_started_at.getTime() + 3_600_000 - timestamp.getTime()) / 1000));
        await tx.update(schema.authRateLimits).set({ minute_started_at: minuteExpired ? timestamp : row.minute_started_at, minute_count: minuteCount + 1, hour_count: row.hour_count + 1 }).where(eq(schema.authRateLimits.key, key));
      }
      return retry;
    });
  };
}

import { customType } from 'drizzle-orm/pg-core';

/** Keep the existing string API while retaining PostgreSQL's microsecond precision. */
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => 'timestamptz',
  fromDriver(value) {
    // node-postgres/Drizzle supplies the original timestamp string, not a Date.
    // Use Date only for whole-second/offset arithmetic; restore the exact fraction.
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const dated = normalized.length === 10 ? `${normalized}T00:00:00Z` : normalized.replace(/([+-]\d{2})$/, '$1:00');
    const instant = new Date(dated);
    if (!Number.isFinite(instant.getTime())) throw new Error('Invalid persisted core timestamp');
    const fraction = /\.(\d{1,6})(?:Z|[+-])/.exec(dated)?.[1] ?? '';
    return instant.toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(3, '0')}Z`);
  },
});

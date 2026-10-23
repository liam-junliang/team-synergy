import { DomainError } from '@team-synergy/domain';

/** Bootstrap/recovery credentials are short-lived; ordinary user issuance is unchanged. */
export function bootstrapPasswordTtlMinutes(value: string | undefined): number {
  if (value === undefined) return 30;
  const minutes = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(minutes) || minutes > 1440) {
    throw new DomainError('bootstrap_config_invalid', 'TSP_BOOTSTRAP_TTL_MINUTES must be an integer from 1 to 1440');
  }
  return minutes;
}

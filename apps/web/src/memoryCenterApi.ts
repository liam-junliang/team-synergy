import { fetchEnvelope } from './api';
import type { MemoryCenterView } from '../../../packages/contracts/src/memory';
export type { MemoryCenterView } from '../../../packages/contracts/src/memory';

export const memoryCenterKey = (owner: string, project?: string) => ['memory-center', owner, project ?? ''] as const;
export function getMemoryCenter(projectCode?: string) {
  const query = projectCode ? '?' + new URLSearchParams({ projectCode }) : '';
  return fetchEnvelope<MemoryCenterView>('/account/memory-center' + query);
}

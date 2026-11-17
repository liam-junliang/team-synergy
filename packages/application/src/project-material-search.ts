import { Worker } from 'node:worker_threads';
import { DomainError } from '@team-synergy/domain';
import type { ProjectMaterialGrepMatch, ProjectMaterialMetadata } from '@team-synergy/contracts';

export const MATERIAL_SEARCH_TIMEOUT_MS = 1000;
let activeSearches = 0;
export type MaterialSearchInput = { documents: Array<{ metadata: ProjectMaterialMetadata; body: string }>; pattern: string;
  mode: 'literal' | 'regex'; caseSensitive: boolean; contextLines: number; offset: number; limit: number; maxChars: number };
export async function searchMaterialText(input: MaterialSearchInput, timeoutMs = MATERIAL_SEARCH_TIMEOUT_MS): Promise<{
  matches: ProjectMaterialGrepMatch[]; truncated: boolean; nextOffset: number | null;
}> {
  if (activeSearches >= 4) throw new DomainError('material_search_busy', '资料搜索繁忙，请稍后重试');
  activeSearches++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./project-material-search-worker.js', import.meta.url), {
      workerData: input, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
    const running = worker;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DomainError('material_search_timeout', '正则搜索超时，请缩小范围或改用字面搜索')), timeoutMs);
      const stop = () => clearTimeout(timer);
      running.once('message', result => {
        stop();
        if (result.error) reject(new DomainError('material_invalid_regex', '正则表达式无效'));
        else resolve(result);
      });
      running.once('error', () => { stop(); reject(new DomainError('material_search_failed', '资料搜索执行失败')); });
      running.once('exit', code => { stop(); if (code !== 0) reject(new DomainError('material_search_failed', '资料搜索执行失败')); });
    });
  } finally { if (worker) await worker.terminate(); activeSearches--; }
}

/** Bounded dynamic-programming glob matcher; no backtracking regex on caller input. */
export function materialPathMatches(pattern: string, path: string): boolean {
  const memo = new Map<string, boolean>();
  function match(p: number, s: number): boolean {
    const key = `${p}:${s}`, cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (p === pattern.length) result = s === path.length;
    else if (pattern[p] === '*') {
      const double = pattern[p + 1] === '*', next = p + (double ? 2 : 1);
      result = (double && pattern[next] === '/' && match(next + 1, s)) || match(next, s) ||
        (s < path.length && (double || path[s] !== '/') && match(p, s + 1));
    } else result = s < path.length && (pattern[p] === path[s] || (pattern[p] === '?' && path[s] !== '/')) && match(p + 1, s + 1);
    memo.set(key, result); return result;
  }
  return match(0, 0);
}

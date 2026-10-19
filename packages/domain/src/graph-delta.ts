import { z } from 'zod';
import { DomainError } from './errors.js';
import type { PublicCode, RunCode } from '@team-synergy/contracts';

/**
 * 架构不变量 11：Agent 只能提交基于 Graph Snapshot 的 Graph Delta，
 * 不能直接覆盖正式图；自动扫描产生的关系默认是 inferred。
 */
export const DeltaOperationSchema = z.enum(['add_node', 'add_edge', 'update_node', 'invalidate']);
export type DeltaOperation = z.infer<typeof DeltaOperationSchema>;

export interface GraphDeltaChange {
  operation: DeltaOperation;
  from?: string;
  to?: string;
  relation?: string;
  node_id?: string;
  verification?: 'proposed' | 'inferred' | 'confirmed';
  source?: { kind: string; uri: string; revision: string };
}

export interface GraphDelta {
  delta_code: PublicCode;
  base_graph_snapshot: number;
  run_code: RunCode;
  changes: GraphDeltaChange[];
}

const SCAN_SOURCE_KINDS = new Set(['scan', 'code_scan', 'tree_sitter', 'lsp']);

/** Delta 的 base snapshot 必须等于当前快照：只能基于快照提出变更，不能直接覆盖 */
export function assertDeltaBase(delta: GraphDelta, currentSnapshot: number): void {
  if (delta.base_graph_snapshot !== currentSnapshot) {
    throw new DomainError('delta_base_mismatch', 'Graph Delta 必须基于当前 Graph Snapshot（架构不变量 11）', {
      delta_base: delta.base_graph_snapshot,
      current_snapshot: currentSnapshot,
    });
  }
}

/** 变更合法性：扫描来源的变更不能自称 confirmed */
export function assertDeltaChanges(delta: GraphDelta): void {
  for (const change of delta.changes) {
    if (
      change.verification === 'confirmed' &&
      (!change.source || SCAN_SOURCE_KINDS.has(change.source.kind))
    ) {
      throw new DomainError('delta_scan_cannot_confirm', '自动扫描产生的变更默认 inferred，不能直接 confirmed（架构不变量 11）', {
        delta_code: delta.delta_code,
      });
    }
  }
}

import { z } from 'zod';
import { DomainError } from './errors.js';

/**
 * 架构不变量 9：Context Node/Edge 必须有来源版本、Verification 和 Freshness；
 * 自动扫描不能直接产生 confirmed 业务语义。
 */
export const NodeVerificationSchema = z.enum(['proposed', 'inferred', 'confirmed']);
export type NodeVerification = z.infer<typeof NodeVerificationSchema>;

export const FreshnessSchema = z.enum(['current', 'stale', 'unknown']);
export type Freshness = z.infer<typeof FreshnessSchema>;

export interface ContextSource {
  kind: string; // openapi / git / schema / discussion / scan 等
  uri: string;
  revision: string;
}

export interface ContextNodeLike {
  node_id: string;
  kind: string;
  verification: NodeVerification;
  freshness: Freshness;
  sources: ContextSource[];
}

/** 自动扫描来源（inferred 事实的合法来源），不能单独支撑 confirmed 语义 */
const SCAN_SOURCE_KINDS = new Set(['scan', 'code_scan', 'tree_sitter', 'lsp']);

export function assertNodeIntegrity(node: ContextNodeLike): void {
  if (node.sources.length === 0) {
    throw new DomainError('node_source_required', '没有来源的节点不能进入正式图快照（docs/09）', {
      node_id: node.node_id,
    });
  }
  if (
    node.verification === 'confirmed' &&
    node.sources.every((s) => SCAN_SOURCE_KINDS.has(s.kind))
  ) {
    throw new DomainError('scan_cannot_confirm', '自动扫描不能直接产生 confirmed 业务语义（架构不变量 9）', {
      node_id: node.node_id,
    });
  }
  if (!node.freshness) {
    throw new DomainError('freshness_required', '节点必须标注 freshness（架构不变量 9）', {
      node_id: node.node_id,
    });
  }
}

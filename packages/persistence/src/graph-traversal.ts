import { sql } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import type { SQL } from 'drizzle-orm';
import type { Db } from './db.js';

/**
 * Context Graph 子图遍历（docs/09）：
 * Recursive CTE，方向 incoming / outgoing / both，深度受限。
 *
 * 修复批（review 阻断 5）：
 * - 锚点与每个递归步骤同时限定 graph_id 与 graph_snapshot，杜绝同版本号跨图串数据；
 * - 权限前置：visibleNodeIds 传入后，锚点与递归结果都只落在可见集内。
 */

export type TraversalDirection = 'incoming' | 'outgoing' | 'both';

export interface TraversalResultRow {
  node_id: string;
  depth: number;
}

export interface TraversalRequest {
  graphId: string;
  graphSnapshot: number;
  focusNodes: string[];
  depth: number;
  direction: TraversalDirection;
  /** 权限过滤后的可见节点集（不变量 10：先过滤后遍历）。未提供则视为不可遍历（fail closed）。 */
  visibleNodeIds: string[];
}

type RawTraversalRow = Record<string, unknown> & {
  node_id: string;
  depth: number;
};

function assertRequest(req: TraversalRequest): void {
  if (!req.graphId) {
    throw new DomainError('graph_id_required', '图遍历必须指定 graph_id（不变量 10 隔离边界）');
  }
  if (req.visibleNodeIds.length === 0 && req.focusNodes.length > 0) {
    throw new DomainError('visible_set_required', '图遍历必须提供权限过滤后的可见节点集（架构不变量 10）');
  }
}

function textArray(values: string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

async function traverseOneDirection(
  db: Db,
  direction: 'incoming' | 'outgoing',
  req: TraversalRequest,
): Promise<TraversalResultRow[]> {
  const anchorCol = direction === 'outgoing' ? 'from_node_id' : 'to_node_id';
  const resultCol = direction === 'outgoing' ? 'to_node_id' : 'from_node_id';
  const focusArray = textArray(req.focusNodes);
  const visibleArray = textArray(req.visibleNodeIds);

  const query = sql`
    WITH RECURSIVE selected_snapshot AS (
      SELECT s.id AS snapshot_id
      FROM context_graph_snapshots s
      JOIN context_graphs g ON g.id = s.graph_id
      WHERE g.code = ${req.graphId}
        AND s.graph_snapshot = ${req.graphSnapshot}
      LIMIT 1
    ),
    visible_nodes AS (
      SELECT n.id, n.node_key
      FROM context_nodes n
      JOIN selected_snapshot s ON s.snapshot_id = n.snapshot_id
      WHERE n.node_key = ANY(${visibleArray})
    ),
    focus_nodes AS (
      SELECT v.id, v.node_key
      FROM visible_nodes v
      WHERE v.node_key = ANY(${focusArray})
    ),
    traverse(node_id, depth) AS (
      SELECT e.${sql.raw(resultCol)}, 1
      FROM context_edges e
      JOIN selected_snapshot s ON s.snapshot_id = e.snapshot_id
      JOIN focus_nodes f ON e.${sql.raw(anchorCol)} = f.id
      JOIN visible_nodes v ON v.id = e.${sql.raw(resultCol)}
      UNION
      SELECT e.${sql.raw(resultCol)}, t.depth + 1
      FROM context_edges e
      JOIN selected_snapshot s ON s.snapshot_id = e.snapshot_id
      JOIN traverse t ON e.${sql.raw(anchorCol)} = t.node_id
      JOIN visible_nodes v ON v.id = e.${sql.raw(resultCol)}
      WHERE t.depth < ${req.depth}
    )
    SELECT n.node_key AS node_id, MIN(t.depth)::int AS depth
    FROM traverse t
    JOIN context_nodes n ON n.id = t.node_id
    GROUP BY n.node_key
  `;

  const result = await db.execute<RawTraversalRow>(query);
  return result.rows.map((row) => ({ node_id: row.node_id, depth: row.depth }));
}

export async function traverseSubgraph(db: Db, req: TraversalRequest): Promise<TraversalResultRow[]> {
  assertRequest(req);
  if (req.focusNodes.length === 0) return [];

  const visibleSet = new Set(req.visibleNodeIds);
  const focusVisible = req.focusNodes.filter((id) => visibleSet.has(id));
  if (focusVisible.length === 0) return [];

  const effective = { ...req, focusNodes: focusVisible };
  const rows =
    req.direction === 'both'
      ? [
          ...(await traverseOneDirection(db, 'incoming', effective)),
          ...(await traverseOneDirection(db, 'outgoing', effective)),
        ]
      : await traverseOneDirection(db, req.direction, effective);

  const best = new Map<string, number>();
  for (const focusNode of focusVisible) {
    best.set(focusNode, 0);
  }
  for (const row of rows) {
    const previousDepth = best.get(row.node_id);
    if (previousDepth === undefined || row.depth < previousDepth) {
      best.set(row.node_id, row.depth);
    }
  }
  return [...best.entries()].map(([node_id, depth]) => ({ node_id, depth }));
}

import { DomainError } from './errors.js';

/**
 * 架构不变量 10：图查询必须先按 Principal/Run 权限过滤，再遍历和裁剪。
 * 避免隐藏节点的存在通过路径或数量泄露。
 */
export interface GraphNode {
  node_id: string;
  kind: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface ProjectionRequest {
  focus_nodes: string[];
  depth: number;
  /** 权限过滤：返回 false 的节点对当前 Principal/Run 不可见 */
  isVisible: (nodeId: string) => boolean;
}

export interface ProjectionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 被权限过滤掉的节点数（不含 ID，防止通过数量推断存在性？——仅用于内部审计，不暴露给 Agent） */
  filteredCount: number;
}

/**
 * 投影管线：先过滤后遍历。
 * 实现顺序被函数结构强制：visible 节点集先建立，BFS 只在可见子图内进行。
 */
export function projectSubgraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  req: ProjectionRequest,
): ProjectionResult {
  // 第 1 步：权限过滤（先于一切遍历）
  const visible = new Set(nodes.filter((n) => req.isVisible(n.node_id)).map((n) => n.node_id));
  const filteredCount = nodes.length - visible.size;

  // 第 2 步：在可见子图内 BFS 裁剪
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue; // 隐藏边一并移除
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }

  const reached = new Set<string>();
  const queue: Array<{ id: string; level: number }> = req.focus_nodes
    .filter((id) => visible.has(id))
    .map((id) => ({ id, level: 0 }));

  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    if (level >= req.depth) continue;
    for (const next of adjacency.get(id) ?? []) {
      queue.push({ id: next, level: level + 1 });
    }
  }

  const keptNodes = nodes.filter((n) => reached.has(n.node_id) && nodeById.has(n.node_id));
  const keptEdges = edges.filter((e) => reached.has(e.from) && reached.has(e.to));

  return { nodes: keptNodes, edges: keptEdges, filteredCount };
}

/** 断言：投影请求必须携带权限过滤函数（不变量 10 的强制入口） */
export function assertPermissionFilter(req: ProjectionRequest): void {
  if (typeof req.isVisible !== 'function') {
    throw new DomainError('permission_filter_required', '图查询必须先按 Principal/Run 权限过滤（架构不变量 10）');
  }
}

import type { CodeUaGraph, CodeUaMapResult } from '../../../packages/contracts/src/code-understanding';

export type UaReaderProfile = NonNullable<CodeUaMapResult['reader_profile']>;

export const UA_READER_ROOT = '/vendor/ua-reader/2.9.8/';

/** The reader runs with an opaque origin and receives published data, never platform credentials. */
export function uaReaderDocument(script: string, styles: string, channel: string): string {
  const escapedScript = script.replace(/<\/script/gi, '<\\/script');
  const escapedStyles = styles.replace(/<\/style/gi, '<\\/style');
  const nonceValue = JSON.stringify(channel).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"><style>${escapedStyles}</style></head><body><div id="root"></div><script>window.__TSP_UA_CHANNEL__=${nonceValue};</script><script>${escapedScript}</script></body></html>`;
}

export function uaReaderNodeMessage(data: unknown, channel: string, graph: CodeUaGraph): { type: 'select' | 'evidence'; id: string } | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.channel !== channel || !['tsp.ua.select', 'tsp.ua.evidence'].includes(String(value.type)) || typeof value.node_id !== 'string') return null;
  if (!graph.nodes.some(node => node.id === value.node_id)) return null;
  return { type: value.type === 'tsp.ua.evidence' ? 'evidence' : 'select', id: `ua:${value.node_id}` };
}

/** Domain data is already in the native graph. Keep the same IDs and explicitly ordered edges. */
export function uaDomainGraph(graph: CodeUaGraph, profile: UaReaderProfile = 'legacy_split'): CodeUaGraph | null {
  if (profile === 'full_system') return null;
  const domainIds = new Set(graph.nodes.filter(node => ['domain', 'flow', 'step'].includes(node.type)).map(node => node.id));
  if (!domainIds.size) return null;
  return { ...graph, nodes: graph.nodes.filter(node => domainIds.has(node.id)), edges: graph.edges.filter(edge => domainIds.has(edge.source) && domainIds.has(edge.target)), layers: [], tour: [] };
}

export function uaStructuralGraph(graph: CodeUaGraph, profile: UaReaderProfile = 'legacy_split'): CodeUaGraph {
  if (profile === 'full_system') return graph;
  const nodes = graph.nodes.filter(node => !['domain', 'flow', 'step'].includes(node.type));
  const ids = new Set(nodes.map(node => node.id));
  return { ...graph, nodes,
    edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    layers: graph.layers.map(layer => ({ ...layer, nodeIds: layer.nodeIds.filter(id => ids.has(id)) })).filter(layer => layer.nodeIds.length > 0),
    tour: [...graph.tour].sort((a, b) => a.order - b.order).map(step => ({ ...step, nodeIds: step.nodeIds.filter(id => ids.has(id)) })).filter(step => step.nodeIds.length > 0).map((step, order) => ({ ...step, order })),
  };
}

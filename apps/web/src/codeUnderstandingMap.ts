import type { CodeGraphResult, CodeUnderstandingContext } from '../../../packages/contracts/src/code-understanding.ts';
import type { WorkspaceRoute } from './workspaceRouting.ts';

export type MapNode = CodeGraphResult['nodes'][number];
export const nodeKey = (node: Pick<MapNode, 'run_code' | 'id'>): string => `${node.run_code}:${node.id}`;

/** Every aggregate endpoint is qualified by run, even when native IDs collide across repositories. */
export function layoutCodeMap(nodes: MapNode[], edges: CodeGraphResult['edges'], layerFilter = '') {
  const layers = [...new Set(nodes.map(node => node.layer || node.kind))];
  const filtered = nodes.filter(node => !layerFilter || (node.layer || node.kind) === layerFilter);
  let column = 0;
  const groups = layers.filter(layer => !layerFilter || layer === layerFilter).map(layer => {
    const members = filtered.filter(node => (node.layer || node.kind) === layer);
    const x = 30 + column * 250;
    const placed = members.map((node, index) => ({ ...node, x: x + Math.floor(index / 8) * 250, y: 80 + (index % 8) * 92 }));
    column += Math.max(1, Math.ceil(members.length / 8));
    return { layer, x, width: Math.max(1, Math.ceil(members.length / 8)) * 250 - 20, nodes: placed };
  });
  const placed = groups.flatMap(group => group.nodes);
  const byKey = new Map(placed.map(node => [nodeKey(node), node]));
  const links = edges.flatMap(edge => {
    const source = byKey.get(`${edge.run_code}:${edge.source}`);
    const target = byKey.get(`${edge.run_code}:${edge.target}`);
    return source && target ? [{ ...edge, sourceNode: source, targetNode: target }] : [];
  });
  return { groups, nodes: placed, links, width: Math.max(1000, column * 250 + 30), height: Math.max(520, Math.min(8, Math.max(0, ...groups.map(group => group.nodes.length))) * 92 + 100) };
}

/** One mainline per repository; historical routes retain their exact snapshot. */
export function resolveCodeSelection(context: CodeUnderstandingContext, route: WorkspaceRoute) {
  const viewCode = route.understandingView || (!route.understandingRun ? context.current_view : undefined);
  const view = context.views.find(item => item.code === viewCode);
  const repositoryCode = route.understandingRepository || view?.selections[0]?.repository_code || context.repositories[0]?.code;
  const repository = context.repositories.find(item => item.code === repositoryCode);
  const viewSelection = view?.selections.find(item => item.repository_code === repositoryCode);
  const branch = repository?.default_branch;
  const latest = context.runs.filter(item => item.status === 'succeeded' &&
    item.kind === 'commit' && item.repository_code === repositoryCode && branch &&
    [branch, 'refs/heads/' + branch, 'origin/' + branch, 'refs/remotes/origin/' + branch].includes(item.requested_ref))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.created_at.localeCompare(left.created_at) || right.code.localeCompare(left.code))[0];
  const runCode = route.understandingRun || viewSelection?.run_code || (!route.understandingView ? latest?.code : undefined);
  const run = context.runs.find(item => item.code === runCode);
  const invalid = Boolean(route.understandingRun && (!run || (route.understandingRepository && run.repository_code !== route.understandingRepository)))
    || Boolean(route.understandingView && (!view || !viewSelection || (run && viewSelection.run_code !== run.code)))
    || Boolean(route.understandingRepository && !context.repositories.some(repo => repo.code === route.understandingRepository));
  const adoptedRun = context.views.find(item => item.code === context.current_view)?.selections
    .find(item => item.repository_code === run?.repository_code)?.run_code;
  const mainline = Boolean(run && !route.understandingView && (adoptedRun ? adoptedRun === run.code : latest?.code === run.code));
  return { view, run, invalid, mainline, query: invalid ? null : run ? { run_code: run.code } : null };
}

export function codeNodeRelations(result: CodeGraphResult, selected: MapNode, direction: 'in' | 'out' | 'both') {
  const nodes = new Map(result.nodes.map(node => [nodeKey(node), node]));
  return result.edges.filter(edge => edge.run_code === selected.run_code
    && ((direction !== 'in' && edge.source === selected.id) || (direction !== 'out' && edge.target === selected.id)))
    .map(edge => ({ edge, outgoing: edge.source === selected.id,
      node: nodes.get(`${edge.run_code}:${edge.source === selected.id ? edge.target : edge.source}`) }));
}

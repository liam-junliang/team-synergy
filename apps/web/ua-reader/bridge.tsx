/** Platform adapter for the pinned MIT-licensed UA 2.9.8 dashboard. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { validateGraph } from '@understand-anything/core/schema';
import type { KnowledgeGraph } from '@understand-anything/core/types';
import { DashboardContent } from './App';
import { I18nProvider } from './contexts/I18nContext';
import { applyTheme, ThemeProvider, type ThemeConfig } from './themes';
import { useDashboardStore } from './store';
import './index.css';

declare global {
  interface Window { __TSP_UA_CHANNEL__?: string }
}

const channel = window.__TSP_UA_CHANNEL__;
if (typeof channel !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(channel)) {
  throw new Error('A platform reader channel is required');
}

const readerTheme: ThemeConfig = { presetId: 'light-minimal', accentId: 'teal', headingFont: 'sans' };
applyTheme(readerTheme);

function notify(type: string, value: Record<string, unknown> = {}) {
  window.parent.postMessage({ type, channel, ...value }, '*');
}

function parseGraph(value: unknown): KnowledgeGraph {
  const result = validateGraph(value);
  if (!result.success || !result.data || result.fatal) throw new Error(result.fatal ?? 'Invalid UA graph');
  if (result.data.kind && result.data.kind !== 'codebase') throw new Error('This reader accepts codebase graphs');
  return result.data;
}

function selectNode(nodeId: unknown) {
  const state = useDashboardStore.getState();
  if (state.selectedNodeId === nodeId) return;
  if (nodeId === null) { state.selectNode(null); return; }
  if (typeof nodeId !== 'string') return;
  const node = state.domainGraph?.nodes.find(item => item.id === nodeId);
  if (node) {
    const graph = state.domainGraph;
    if (!graph) return;
    let domainId = node.type === 'domain' ? node.id : null;
    let flowId = node.type === 'flow' ? node.id : null;
    if (node.type === 'step') flowId = graph.edges.find(edge => edge.type === 'flow_step' && edge.target === node.id)?.source ?? null;
    if (!domainId && flowId) domainId = graph.edges.find(edge => edge.type === 'contains_flow' && edge.target === flowId)?.source ?? null;
    if (domainId) state.navigateToDomain(domainId);
    else state.setViewMode('domain');
    useDashboardStore.getState().selectNode(nodeId);
  } else if (state.nodesById.has(nodeId)) {
    if (state.viewMode !== 'structural') state.setViewMode('structural');
    useDashboardStore.getState().navigateToNode(nodeId);
  }
}

function Reader() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState('zh');

  useEffect(() => {
    let applyingSelection = false;
    const unsubscribe = useDashboardStore.subscribe((state, previous) => {
      if (!applyingSelection && state.selectedNodeId !== previous.selectedNodeId) {
        notify('tsp.ua.select', { node_id: state.selectedNodeId });
      }
    });
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      if (data.channel !== channel) return;
      if (data.type === 'tsp.ua.load') {
        try {
          const graph = parseGraph(data.graph);
          const domainGraph = data.reader_profile !== 'full_system' && data.domain_graph ? parseGraph(data.domain_graph) : null;
          document.documentElement.dataset.tspReaderProfile = data.reader_profile === 'full_system' ? 'full_system' : 'legacy_split';
          applyingSelection = true;
          const state = useDashboardStore.getState();
          state.stopTour();
          state.navigateToOverview();
          useDashboardStore.setState({ domainGraph: null, activeDomainId: null, nodeHistory: [], searchQuery: '', searchResults: [] });
          state.setGraph(graph);
          if (domainGraph) state.setDomainGraph(domainGraph);
          if (data.selected_node_id !== undefined) selectNode(data.selected_node_id);
          setLocale(typeof data.locale === 'string' ? data.locale : 'zh');
          setError(null);
          setLoaded(true);
          notify('tsp.ua.loaded', { node_count: graph.nodes.length, domain_node_count: domainGraph?.nodes.length ?? 0 });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Unable to load UA graph';
          setError(message);
          notify('tsp.ua.error', { message });
        } finally { applyingSelection = false; }
      } else if (data.type === 'tsp.ua.select') {
        applyingSelection = true;
        try { selectNode(data.node_id); } finally { applyingSelection = false; }
      }
    };
    window.addEventListener('message', receive);
    notify('tsp.ua.ready');
    return () => { window.removeEventListener('message', receive); unsubscribe(); };
  }, []);

  if (!loaded || error) return <div className="h-screen grid place-items-center bg-root text-text-secondary text-sm"><p role={error ? 'alert' : 'status'}>{error ?? '正在载入项目理解地图…'}</p></div>;
  return <I18nProvider language={locale}><ThemeProvider metaTheme={readerTheme}><DashboardContent accessToken="" loadError={null} graphIssues={[]} graphFreshness={null} /></ThemeProvider></I18nProvider>;
}

const root = document.getElementById('root');
if (!root) throw new Error('The reader root is missing');
createRoot(root).render(<Reader />);

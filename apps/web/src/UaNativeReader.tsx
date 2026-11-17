import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeUaGraph } from '../../../packages/contracts/src/code-understanding';
import { t } from './i18n';
import { UA_READER_ROOT, uaDomainGraph, uaStructuralGraph, uaReaderDocument, uaReaderNodeMessage, type UaReaderProfile } from './uaReaderBridge';

export function UaNativeReader({ graph, readerProfile = 'legacy_split', selectedNode, locale, onSelect, onEvidence }: {
  graph: CodeUaGraph; readerProfile?: UaReaderProfile; selectedNode?: string; locale: string;
  onSelect: (id: string) => void; onEvidence: (id: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const [assets, setAssets] = useState<{ script: string; styles: string } | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onSelect, onEvidence });
  const frameSelection = useRef<string | null>(null);
  callbacks.current = { onSelect, onEvidence };
  const graphRef = useRef(graph); graphRef.current = graph;
  const document = useMemo(() => assets ? uaReaderDocument(assets.script, assets.styles, channel) : undefined, [assets, channel]);
  useEffect(() => {
    const controller = new AbortController();
    const readAsset = async (name: string) => {
      const response = await fetch(`${UA_READER_ROOT}${name}`, { signal: controller.signal, credentials: 'omit', cache: 'no-cache' });
      if (!response.ok) throw new Error(t('UA 阅读器资源加载失败，请刷新重试。'));
      return response.text();
    };
    void Promise.all([readAsset('reader.js'), readAsset('reader.css')]).then(([script, styles]) => setAssets({ script, styles })).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== 'null' || event.source !== frame.current?.contentWindow || event.data?.channel !== channel) return;
      if (event.data.type === 'tsp.ua.ready') { setReady(true); return; }
      if (event.data.type === 'tsp.ua.error') { setError(String(event.data.message || t('UA 阅读器加载失败。')).slice(0, 500)); return; }
      const message = uaReaderNodeMessage(event.data, channel, graphRef.current);
      if (message?.type === 'select') { frameSelection.current = message.id; callbacks.current.onSelect(message.id); }
      if (message?.type === 'evidence') callbacks.current.onEvidence(message.id);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [channel]);
  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ type: 'tsp.ua.load', channel, reader_profile: readerProfile, graph: uaStructuralGraph(graph, readerProfile), domain_graph: uaDomainGraph(graph, readerProfile), locale }, '*');
  }, [ready, graph, readerProfile, channel, locale]);
  useEffect(() => {
    if (!ready || !selectedNode?.startsWith('ua:')) return;
    // A native selection updates the URL. Do not navigate the same node back into
    // the reader: that would duplicate its breadcrumbs and reset its viewport.
    if (frameSelection.current === selectedNode) return;
    const id = selectedNode.slice(3);
    if (graph.nodes.some(node => node.id === id)) {
      frameSelection.current = selectedNode;
      frame.current?.contentWindow?.postMessage({ type: 'tsp.ua.select', channel, node_id: id }, '*');
    }
  }, [ready, selectedNode, graph, channel]);
  return <section className="cu-native-reader" aria-label={t('UA 原生阅读器')} data-reader-profile={readerProfile}>
    {error ? <p role="alert" className="cu-notice cu-error">{error}</p> : <>
      {!ready && <p role="status" className="cu-reader-loading">{t('正在加载 UA 阅读器…')}</p>}
      <iframe ref={frame} title={t('UA 原生项目地图')} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} />
    </>}
  </section>;
}

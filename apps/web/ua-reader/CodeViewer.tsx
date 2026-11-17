/** The reader receives published evidence; source ownership stays with the analysis runner. */
import { useEffect } from 'react';
import { useDashboardStore } from '../store';

interface Props { accessToken: string; presentation?: 'sidebar' | 'modal'; onClose?: () => void; onExpand?: () => void }

export default function CodeViewer({ onClose }: Props) {
  const nodeId = useDashboardStore(state => state.codeViewerNodeId);
  const close = useDashboardStore(state => state.closeCodeViewer);
  useEffect(() => {
    const state = useDashboardStore.getState();
    const node = state.graph?.nodes.find(item => item.id === nodeId) ?? state.domainGraph?.nodes.find(item => item.id === nodeId);
    if (node) window.parent.postMessage({ type: 'tsp.ua.evidence', channel: window.__TSP_UA_CHANNEL__, node_id: node.id, path: node.filePath ?? null }, '*');
  }, [nodeId]);
  return <section className="h-full flex flex-col gap-4 p-5 text-text-secondary bg-surface"><div className="flex items-center justify-between"><strong className="text-text-primary">代码证据</strong><button type="button" className="px-3 py-1 rounded border border-border-subtle" onClick={onClose ?? close}>关闭</button></div><p className="text-sm">已在平台打开关联符号、路径行号和证据片段。完整源码由分析执行端保管，请依据提交号或快照指纹核对原件。</p></section>;
}

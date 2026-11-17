/** Use the renderer's actual container topology; graph edges are never rewritten. */
export function selectedNodeContainer(profile: unknown, selectedNodeId: string | null, topology: ReadonlyMap<string, string> | undefined): string | null {
  if (profile !== 'full_system' || !selectedNodeId) return null;
  const container = topology?.get(selectedNodeId);
  return container && container !== selectedNodeId ? container : null;
}

interface SelectionFitOptions {
  nodeId: string;
  getNode: (id: string) => { measured?: { width?: number; height?: number } } | undefined;
  fit: () => void;
  requestFrame: (action: () => void) => number;
  cancelFrame: (id: number) => void;
  schedule: (action: () => void, delay: number) => number;
  cancelScheduled: (id: number) => void;
}

/** Stage 2 children appear asynchronously. Never position on a missing placeholder. */
export function waitForSelectedNode(options: SelectionFitOptions): () => void {
  let cancelled = false, frame = 0, frameId = 0, timerId = 0;
  const ready = () => { const node = options.getNode(options.nodeId); return Boolean(node?.measured?.width && node.measured.height); };
  const poll = () => {
    if (cancelled) return;
    if (ready()) {
      // Let the layer's own fit start first. Fit through React Flow so nested
      // child positions use its real absolute coordinates rather than parent boxes.
      timerId = options.schedule(() => {
        timerId = 0;
        if (cancelled) return;
        if (ready()) options.fit();
        else if (++frame < 240) frameId = options.requestFrame(poll);
      }, 100);
    } else if (++frame < 240) frameId = options.requestFrame(poll);
  };
  frameId = options.requestFrame(poll);
  return () => { cancelled = true; options.cancelFrame(frameId); if (timerId) options.cancelScheduled(timerId); };
}

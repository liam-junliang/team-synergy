import { getLocale } from './i18n.ts';
import { SVG_PREVIEW_MAX_BYTES, svgImageUrl } from './diagramRendering';

export const DRAWIO_ORIGIN = 'https://embed.diagrams.net';
export const EMPTY_DRAWIO_SOURCE = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;

export function drawioFrameUrl(readOnly: boolean): string {
  const url = new URL('/', DRAWIO_ORIGIN);
  url.search = new URLSearchParams({
    embed: '1', proto: 'json', spin: '1', libraries: '1', lang: getLocale() === 'en-US' ? 'en' : 'zh',
    saveAndExit: readOnly ? '0' : '1', noSaveBtn: '1', noExitBtn: readOnly ? '1' : '0',
    chrome: readOnly ? '0' : '1', nav: '1', layers: '1',
    noPrint: '1', noExport: readOnly ? '1' : '0',
    configure: '1', suppressNewWindows: '1', browser: '0',
  }).toString();
  return url.href;
}

type DrawioEvent = Record<string, unknown> & { event: string };

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readDrawioEvent(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, frameWindow: Window | null): DrawioEvent | null {
  if (!frameWindow || event.origin !== DRAWIO_ORIGIN || event.source !== frameWindow || typeof event.data !== 'string' || event.data.length > 24 * 1024 * 1024) return null;
  const data = record(event.data);
  if (!data || typeof data.event !== 'string') return null;
  if (!['configure', 'init', 'load', 'save', 'export', 'exit'].includes(data.event)) return null;
  return data as DrawioEvent;
}

export function validateDrawioSource(source: string): void {
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) throw new Error('draw.io 图源不能超过 6 MiB。');
  const content = source.trim().replace(/^<\?xml\s[^?]*\?>\s*/i, '').replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || !/^<(?:mxfile|mxGraphModel)(?:\s|>)/.test(content)) {
    throw new Error('请提供有效的 draw.io XML 图源（mxfile 或 mxGraphModel）。');
  }
}

export function decodeDrawioSvg(data: unknown): string | null {
  if (typeof data !== 'string' || data.length > 6 * SVG_PREVIEW_MAX_BYTES) return null;
  const match = /^data:image\/svg\+xml((?:;[^,]*)?),(.*)$/s.exec(data);
  if (!match) return null;
  try {
    const svg = /;base64(?:;|$)/i.test(match[1])
      ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0)))
      : decodeURIComponent(match[2]);
    return svgImageUrl(svg) ? svg : null;
  } catch { return null; }
}

export interface DrawioSaveResult {
  source: string;
  previewSvg?: string;
}

interface SessionOptions {
  source: string;
  readOnly: boolean;
  send: (message: Record<string, unknown>) => void;
  onLoaded: () => void;
  onError: (message: string) => void;
  onExporting: (source: string) => void;
  onSave: (result: DrawioSaveResult) => void;
  onExit: (modified: boolean) => void;
}

let nextSessionId = 0;

/** One bridge per iframe lifetime. A save exports its own XML snapshot. */
export function createDrawioSession(options: SessionOptions) {
  const sessionId = ++nextSessionId;
  let sequence = 0;
  let disposed = false;
  let initialized = false;
  let pending: { source: string; requestId: string } | null = null;

  return {
    receive(event: DrawioEvent) {
      if (disposed) return;
      if (event.event === 'configure') {
        options.send({ action: 'configure', config: { suppressNewWindows: true, preserveViewState: true } });
      } else if (event.event === 'init') {
        if (initialized) return;
        try {
          const source = options.source.trim() || EMPTY_DRAWIO_SOURCE;
          validateDrawioSource(source);
          initialized = true;
          options.send({ action: 'load', xml: source, autosave: 0, modified: false, fit: 1, saveAndExit: options.readOnly ? 0 : 1 });
        } catch (error) {
          options.onError(error instanceof Error ? error.message : '无法加载 draw.io 图源。');
        }
      } else if (!initialized) {
        return;
      } else if (event.event === 'load') {
        if (event.error) options.onError('draw.io 无法加载图源，请检查 XML 内容。');
        else options.onLoaded();
      } else if (event.event === 'save' && !options.readOnly && typeof event.xml === 'string') {
        pending = null;
        try { validateDrawioSource(event.xml); } catch (error) {
          options.onError(error instanceof Error ? error.message : 'draw.io 返回了无效图源。');
          return;
        }
        pending = { source: event.xml, requestId: `acp-drawio-${sessionId}-${++sequence}` };
        options.onExporting(pending.source);
        options.send({ action: 'export', format: 'svg', xml: pending.source, requestId: pending.requestId, embedImages: true, embedFonts: false });
      } else if (event.event === 'export' && pending) {
        // draw.io echoes the complete export action as `message`. A source
        // change or a second Save must never attach a previous render.
        const request = record(event.message);
        if (request?.requestId !== pending.requestId || request?.xml !== pending.source || event.format !== 'svg') return;
        const previewSvg = event.error ? null : decodeDrawioSvg(event.data);
        if (!previewSvg) {
          options.onError('预览生成失败，可保留图源后稍后重试预览。');
          return;
        }
        const source = pending.source;
        pending = null;
        options.onSave({ source, previewSvg });
      } else if (event.event === 'exit' && !options.readOnly) {
        // Some editor integrations follow Save and Exit with an exit event.
        // Keep the iframe alive until the matching preview has been returned.
        if (pending) return;
        options.onExit(event.modified === true);
      }
    },
    saveSourceOnly() {
      if (!disposed && pending) {
        const source = pending.source;
        pending = null;
        options.onSave({ source });
      }
    },
    hasPendingSource() { return pending !== null; },
    dispose() { disposed = true; pending = null; },
  };
}

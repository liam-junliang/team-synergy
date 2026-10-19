import type { Mermaid, MermaidConfig } from 'mermaid';

export const MERMAID_MAX_SOURCE_LENGTH = 100_000;
export const SVG_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  maxTextSize: MERMAID_MAX_SOURCE_LENGTH,
  maxEdges: 1_000,
  theme: 'default',
  fontFamily: 'Arial, "Microsoft YaHei", sans-serif',
  flowchart: { htmlLabels: false },
  secure: ['securityLevel', 'startOnLoad', 'suppressErrorRendering', 'htmlLabels', 'maxTextSize', 'maxEdges', 'secure'],
};

export function validateMermaidSource(source: string): void {
  if (!source.trim()) throw new Error('请输入 Mermaid 图源。');
  if (source.length > MERMAID_MAX_SOURCE_LENGTH) throw new Error('图源超过预览上限（100,000 字符），请拆分为多张图。');
  // Diagram text must not override application security or inject theme CSS.
  // Both legacy directives and YAML frontmatter can change Mermaid config.
  if (/%%\s*\{/.test(source) || /^\s*---(?:\r?\n|$)/.test(source)) {
    throw new Error('请移除 Mermaid 初始化指令或 YAML 配置，图表样式由平台统一管理。');
  }
}

/** SVG is only used as an image URL, never inserted into the application's DOM. */
export function svgImageUrl(svg: string): string | null {
  if (new TextEncoder().encode(svg).length > SVG_PREVIEW_MAX_BYTES || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(svg)) return null;
  const content = svg.trim().replace(/^<\?xml\s[^?]*\?>\s*/i, '').replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
  if (!/^<svg(?:\s|>)/i.test(content) || !/(?:<\/svg\s*>|\/>)\s*$/i.test(content)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function mermaidImageDimensions(svg: string): { width: number; height: number } | undefined {
  const attributes = /^\s*<svg\b([^>]*)>/i.exec(svg)?.[1];
  if (!attributes) return undefined;
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`).exec(attributes)?.[2];
  const box = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return undefined;
  const pixels = (value: string | undefined) => value && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? Number.parseFloat(value) : undefined;
  const width = pixels(attribute('width')) ?? box[2];
  const height = pixels(attribute('height')) ?? (width * box[3] / box[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const scale = Math.min(1, 20_000 / width, 20_000 / height);
  return { width: width * scale, height: height * scale };
}

let mermaidPromise: Promise<Mermaid> | undefined;
let nextDiagramId = 0;

export function createMermaidRenderId(): string {
  return `acp-mermaid-${++nextDiagramId}`;
}

export async function renderMermaidImage(source: string, signal: AbortSignal): Promise<{ image: string; width?: number; height?: number }> {
  validateMermaidSource(source);
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    }).catch((error: unknown) => {
      mermaidPromise = undefined;
      throw error;
    });
  }
  const mermaid = await mermaidPromise;
  signal.throwIfAborted();
  const staging = document.createElement('div');
  staging.setAttribute('aria-hidden', 'true');
  staging.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
  document.body.append(staging);
  try {
    // Mermaid serializes calls internally. Each render still gets a unique ID,
    // including when an earlier render of the same component is in flight.
    const { svg } = await mermaid.render(createMermaidRenderId(), source, staging);
    signal.throwIfAborted();
    const image = svgImageUrl(svg);
    if (!image) throw new Error('生成的图表无法预览，请缩小图表后重试。');
    // Mermaid's responsive SVG uses width="100%". An <img> otherwise falls
    // back to a 300px intrinsic width instead of the diagram's real extent.
    return { image, ...mermaidImageDimensions(svg) };
  } finally {
    staging.remove();
  }
}

import { getLocale } from './i18n.ts';
import type { ArchitectureContentKind, ArchitectureDocumentDetail, ArchitectureDocumentInput, ArchitectureDocumentRevisionInput } from './api';

export const ARCHITECTURE_SOURCE_LIMIT = 6 * 1024 * 1024;
export const ARCHITECTURE_PREVIEW_LIMIT = 2 * 1024 * 1024;
export const ARCHITECTURE_KIND_LABEL: Record<ArchitectureContentKind, string> = { mermaid: 'Mermaid', drawio: 'draw.io', image: '架构图片' };
export const ARCHITECTURE_TEMPLATES: Record<ArchitectureContentKind, string> = {
  mermaid: 'flowchart LR\n  User[用户] --> Web[Web 应用]\n  Web --> API[应用服务]\n  API --> DB[(数据库)]\n',
  drawio: '<mxfile host="app.diagrams.net"><diagram name="总体架构" id="architecture"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageWidth="1169" pageHeight="827"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="应用服务" style="rounded=1;whiteSpace=wrap;html=0;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="160" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>',
  image: '',
};

/** Resolve a starter only when creating or explicitly changing a draft format. */
export function architectureTemplate(kind: ArchitectureContentKind): string {
  const source = ARCHITECTURE_TEMPLATES[kind];
  if (getLocale() !== 'en-US') return source;
  if (kind === 'mermaid') return 'flowchart LR\n  User[User] --> Web[Web app]\n  Web --> API[Application service]\n  API --> DB[(Database)]\n';
  return kind === 'drawio' ? source.replace('总体架构', 'System architecture').replace('应用服务', 'Application service') : source;
}

export interface ArchitectureDraft {
  title: string;
  summary: string;
  content_kind: ArchitectureContentKind;
  source_content: string;
  notes_markdown: string;
  preview_svg: string | null;
  change_summary: string;
}

export function architectureDraft(document?: ArchitectureDocumentDetail): ArchitectureDraft {
  return {
    title: document?.title ?? '', summary: document?.summary ?? '', content_kind: document?.content_kind ?? 'mermaid',
    source_content: document?.source_content ?? architectureTemplate('mermaid'),
    notes_markdown: document?.notes_markdown ?? '', preview_svg: document?.preview_svg ?? null, change_summary: '',
  };
}

export function updateArchitectureSource(draft: ArchitectureDraft, source: string, previewSvg?: string): ArchitectureDraft {
  return { ...draft, source_content: source, preview_svg: previewSvg ?? (source === draft.source_content ? draft.preview_svg : null) };
}

export function validateArchitectureDraft(draft: ArchitectureDraft, revising = false): string | null {
  if (!draft.title.trim()) return '请填写架构名称。';
  if (!draft.source_content.trim()) return draft.content_kind === 'image' ? '请上传架构图片。' : '请填写或导入图源。';
  if (new TextEncoder().encode(draft.source_content).length > ARCHITECTURE_SOURCE_LIMIT) return '图源内容不能超过 6 MiB。';
  if (draft.preview_svg && new TextEncoder().encode(draft.preview_svg).length > ARCHITECTURE_PREVIEW_LIMIT) return '预览图不能超过 2 MiB，请精简图形后重试。';
  if (draft.content_kind === 'image' && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(draft.source_content)) return '仅支持 PNG、JPEG 或 WebP 图片。';
  if (draft.content_kind === 'drawio' && (/<!(?:DOCTYPE|ENTITY)\b/i.test(draft.source_content) || !/<(?:mxfile|mxGraphModel)(?:\s|>)/.test(draft.source_content))) return '请导入有效的 draw.io XML 文件，不支持外部实体声明。';
  if (revising && !draft.change_summary.trim()) return '请说明本次修改的内容。';
  return null;
}

export function architectureWriteInput(draft: ArchitectureDraft, baseRevision?: number): ArchitectureDocumentInput | ArchitectureDocumentRevisionInput {
  const input = { ...draft, title: draft.title.trim(), summary: draft.summary.trim(), change_summary: draft.change_summary.trim() };
  return baseRevision === undefined ? input : { ...input, base_revision: baseRevision };
}

export function isArchitectureRevisionConflict(error: unknown): boolean {
  return /revision_conflict|version_conflict|HTTP 409/.test(error instanceof Error ? error.message : String(error));
}

export function architectureSourceFile(contentKind: ArchitectureContentKind, source: string, title: string, revision?: number): { filename: string; blob: Blob } {
  const name = [...title].map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('').replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 100) || 'architecture';
  const suffix = revision === undefined ? '' : `-r${revision}`;
  if (contentKind === 'image') {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
    if (!match) throw new Error('图片内容无效，无法导出。');
    const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
    return { filename: `${name}${suffix}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`, blob: new Blob([bytes], { type: `image/${match[1]}` }) };
  }
  return { filename: `${name}${suffix}.${contentKind === 'drawio' ? 'drawio' : 'mmd'}`, blob: new Blob([source], { type: contentKind === 'drawio' ? 'application/xml;charset=utf-8' : 'text/plain;charset=utf-8' }) };
}

export async function importArchitectureSource(file: File): Promise<{ content_kind: ArchitectureContentKind; source_content: string }> {
  if (file.size > ARCHITECTURE_SOURCE_LIMIT) throw new Error('导入文件不能超过 6 MiB。');
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
    const mime = png ? 'png' : jpeg ? 'jpeg' : webp ? 'webp' : null;
    if (!mime) throw new Error('文件不是有效的 PNG、JPEG 或 WebP 图片。');
    // Chunking avoids spreading a large upload onto the JavaScript call stack.
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    const source = `data:image/${mime};base64,${btoa(binary)}`;
    if (source.length > ARCHITECTURE_SOURCE_LIMIT) throw new Error('图片编码后超过 6 MiB，请压缩图片后重试。');
    return { content_kind: 'image', source_content: source };
  }
  if (!/\.(mmd|mermaid|drawio|xml)$/i.test(file.name)) throw new Error('请选择 .mmd、.mermaid、.drawio、.xml 或 PNG/JPEG/WebP 文件。');
  const source = await file.text();
  if (new TextEncoder().encode(source).length > ARCHITECTURE_SOURCE_LIMIT) throw new Error('图源内容不能超过 6 MiB。');
  const kind = /\.(drawio|xml)$/i.test(file.name) ? 'drawio' : 'mermaid';
  if (kind === 'drawio' && (/<!(?:DOCTYPE|ENTITY)\b/i.test(source) || !/<(?:mxfile|mxGraphModel)(?:\s|>)/.test(source))) throw new Error('请导入有效的 draw.io XML 文件，不支持外部实体声明。');
  return { content_kind: kind, source_content: source };
}

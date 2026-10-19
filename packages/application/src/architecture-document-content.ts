import { DomainError } from '@team-synergy/domain';

export type ArchitectureContentKind = 'mermaid' | 'drawio' | 'image';
export interface ArchitectureContentInput {
  contentKind?: ArchitectureContentKind;
  sourceContent?: string;
  notesMarkdown?: string;
  previewSvg?: string | null;
}
export interface ArchitectureContent {
  content_kind: ArchitectureContentKind;
  source_content: string;
  notes_markdown: string;
  preview_svg: string | null;
}

export function architectureText(value: string, label: string, maxBytes: number, required = false): string {
  const text = value.replace(/\r\n/g, '\n').trim();
  if ((required && !text) || Buffer.byteLength(text, 'utf8') > maxBytes || text.includes('\0')) {
    throw new DomainError('architecture_document_invalid', `${label}${required ? '不能为空，且' : ''}不能超过 ${maxBytes} 字节`);
  }
  return text;
}

function hasXmlRoot(source: string, names: string[]): boolean {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return false;
  const xml = source.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[\s\S]*?\?>/i, '')
    .replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, '').trim();
  const root = /^<([A-Za-z][\w:.-]*)\b/.exec(xml)?.[1];
  if (!root || !names.includes(root)) return false;
  return new RegExp(`^<${root}\\b[^>]*\\/\\s*>$`).test(xml)
    || new RegExp(`<\\/${root}\\s*>$`).test(xml);
}

function validateImage(source: string): void {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match?.[2]) throw new DomainError('architecture_document_image_invalid', '图片只支持 PNG、JPEG、WebP 的 Base64 data URL');
  const encoded = match[2];
  const bytes = Buffer.from(encoded, 'base64');
  const validEncoding = encoded.length % 4 === 0 && bytes.toString('base64') === encoded;
  const validSignature = match[1] === 'png'
    ? bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND'
    : match[1] === 'jpeg'
      ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217
      : bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) === bytes.length - 8;
  if (!validEncoding || !validSignature) throw new DomainError('architecture_document_image_invalid', '图片编码或文件签名与所声明的格式不一致');
}

/** Validate data only. SVG previews must be consumed through an image URL, never inserted as markup. */
export function normalizeArchitectureContent(input: ArchitectureContentInput, current?: ArchitectureContent): ArchitectureContent {
  const kind = input.contentKind ?? current?.content_kind;
  if (kind !== 'mermaid' && kind !== 'drawio' && kind !== 'image') {
    throw new DomainError('architecture_document_kind_invalid', '架构图类型必须是 mermaid、drawio 或 image');
  }
  const source = input.sourceContent ?? current?.source_content ?? '';
  if (!source.trim() || Buffer.byteLength(source, 'utf8') > 6 * 1024 * 1024 || source.includes('\0')) {
    throw new DomainError('architecture_document_source_invalid', '架构图源不能为空，且不能超过 6 MiB');
  }
  if (kind === 'drawio' && !hasXmlRoot(source, ['mxfile', 'mxGraphModel'])) {
    throw new DomainError('architecture_document_source_invalid', 'draw.io 图源必须是 mxfile 或 mxGraphModel XML，且不能包含 DOCTYPE 或 ENTITY');
  }
  if (kind === 'image') validateImage(source);
  const sourceChanged = current?.source_content !== source || current.content_kind !== kind;
  const preview = input.previewSvg === undefined ? (sourceChanged ? null : current?.preview_svg ?? null) : input.previewSvg;
  if (preview !== null && (Buffer.byteLength(preview, 'utf8') > 2 * 1024 * 1024 || preview.includes('\0') || !hasXmlRoot(preview, ['svg']))) {
    throw new DomainError('architecture_document_preview_invalid', '预览必须是至多 2 MiB 的 SVG，且不能包含 DOCTYPE 或 ENTITY');
  }
  return {
    content_kind: kind,
    source_content: source,
    notes_markdown: input.notesMarkdown === undefined ? current?.notes_markdown ?? '' : architectureText(input.notesMarkdown, '架构说明', 256 * 1024),
    preview_svg: preview,
  };
}

import { createHash } from 'node:crypto';
import { DomainError } from '@team-synergy/domain';
import { schema } from '@team-synergy/persistence';

export type DesignPrototypeContentKind = 'html' | 'image' | 'url' | 'file';

export interface DesignPrototypeContentInput {
  contentKind?: DesignPrototypeContentKind;
  htmlContent?: string;
  externalUrl?: string;
  fileName?: string;
  fileMimeType?: string;
  fileContentBase64?: string;
}

export interface DesignPrototypeContentMetadata {
  content_kind: DesignPrototypeContentKind;
  external_url: string | null;
  file_name: string | null;
  file_mime_type: string | null;
  file_size: number | null;
  file_sha256: string | null;
  download_path: string | null;
}

type Revision = typeof schema.designPrototypeRevisions.$inferSelect;
type Content = Pick<Revision, 'content_kind' | 'html_content' | 'external_url' | 'file_name' | 'file_mime_type' | 'file_size' | 'file_sha256' | 'file_content_base64'>;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const IMAGE_MARKER = /<meta\b[^>]*\bname\s*=\s*["']acp-prototype-kind["'][^>]*\bcontent\s*=\s*["']image["']/i;

// Keep attachment bytes out of detail, task and immutable context projections.
export const designPrototypeRevisionColumns = {
  code: schema.designPrototypeRevisions.code,
  revision: schema.designPrototypeRevisions.revision,
  html_content: schema.designPrototypeRevisions.html_content,
  content_kind: schema.designPrototypeRevisions.content_kind,
  external_url: schema.designPrototypeRevisions.external_url,
  file_name: schema.designPrototypeRevisions.file_name,
  file_mime_type: schema.designPrototypeRevisions.file_mime_type,
  file_size: schema.designPrototypeRevisions.file_size,
  file_sha256: schema.designPrototypeRevisions.file_sha256,
  notes_markdown: schema.designPrototypeRevisions.notes_markdown,
  change_summary: schema.designPrototypeRevisions.change_summary,
  created_by: schema.designPrototypeRevisions.created_by,
  created_at: schema.designPrototypeRevisions.created_at,
};

export function designPrototypeContentMetadata(
  prototypeCode: string,
  revision: Pick<Revision, 'revision' | 'content_kind' | 'html_content' | 'external_url' | 'file_name' | 'file_mime_type' | 'file_size' | 'file_sha256'>,
): DesignPrototypeContentMetadata {
  return {
    content_kind: revision.content_kind === 'html' && IMAGE_MARKER.test(revision.html_content) ? 'image' : revision.content_kind,
    external_url: revision.external_url,
    file_name: revision.file_name,
    file_mime_type: revision.file_mime_type,
    file_size: revision.file_size,
    file_sha256: revision.file_sha256,
    download_path: revision.content_kind === 'file' ? `/design-prototypes/${prototypeCode}/file?revision=${revision.revision}` : null,
  };
}

export function normalizeDesignPrototypeContent(input: DesignPrototypeContentInput, current?: Content): Content {
  const kind = input.contentKind ?? (input.htmlContent?.trim()
    ? (IMAGE_MARKER.test(input.htmlContent) ? 'image' : 'html')
    : current?.content_kind ?? 'html');
  const content: Content = { content_kind: kind, html_content: '', external_url: null, file_name: null,
    file_mime_type: null, file_size: null, file_sha256: null, file_content_base64: null };
  if (kind === 'html' || kind === 'image') {
    const html = (input.htmlContent ?? current?.html_content ?? '').replace(/\r\n/g, '\n').trim();
    if (!html) throw new DomainError('design_prototype_html_required', 'HTML 原型正文不能为空');
    if (html.length > 6 * 1024 * 1024) throw new DomainError('design_prototype_html_too_large', '原型内容不能超过 6 MiB');
    return { ...content, html_content: html };
  }
  if (kind === 'url') {
    const value = (input.externalUrl ?? (current?.content_kind === 'url' ? current.external_url : '') ?? '').trim();
    try {
      const url = new URL(value);
      if (value.length > 8192 || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || !/^https?:\/\//i.test(value)
        || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error();
      return { ...content, external_url: url.href };
    } catch {
      throw new DomainError('design_prototype_url_invalid', '链接必须是有效的 HTTP 或 HTTPS 地址，且不能包含用户名或密码');
    }
  }
  if (kind !== 'file') throw new DomainError('design_prototype_content_kind_invalid', '不支持的原型内容类型');
  const previous = current?.content_kind === 'file' ? current : undefined;
  const name = input.fileName ?? previous?.file_name ?? '';
  if (!name || Buffer.byteLength(name, 'utf8') > 255 || /[<>:"/\\|?*]/.test(name)
    || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new DomainError('design_prototype_file_name_invalid', '文件名不能为空，且不能包含路径或不安全字符');
  }
  const mime = input.fileMimeType ?? previous?.file_mime_type ?? 'application/octet-stream';
  if (mime.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime)) {
    throw new DomainError('design_prototype_file_mime_type_invalid', '文件 MIME 类型无效');
  }
  const encoded = input.fileContentBase64 ?? previous?.file_content_base64;
  if (encoded === undefined || encoded === null) throw new DomainError('design_prototype_file_required', '请选择要保存的文件');
  if (encoded.length > 4 * Math.ceil(MAX_FILE_SIZE / 3)) throw new DomainError('design_prototype_file_too_large', '文件不能超过 20 MiB');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new DomainError('design_prototype_file_encoding_invalid', '文件内容必须是有效的 Base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new DomainError('design_prototype_file_encoding_invalid', '文件内容必须是有效的 Base64');
  if (bytes.length > MAX_FILE_SIZE) throw new DomainError('design_prototype_file_too_large', '文件不能超过 20 MiB');
  return { ...content, file_name: name, file_mime_type: mime.toLowerCase(), file_content_base64: encoded,
    file_size: bytes.length, file_sha256: createHash('sha256').update(bytes).digest('hex') };
}

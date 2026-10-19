import { createHash } from 'node:crypto';
import { DomainError } from '@team-synergy/domain';
import type { SkillFile, SkillPackage } from '@team-synergy/contracts';

export const SKILL_MAX_BYTES = 6 * 1024 * 1024;
export const SKILL_MAX_FILES = 200;
export function skillInvalid(message: string): never { throw new DomainError('skill_invalid', message); }
export function skillText(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) skillInvalid(`${field}不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
export function skillInteger(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) skillInvalid('版本或安装集合版本无效');
  return value as number;
}
export function skillAlias(value: unknown): string {
  const alias = skillText(value, '技能名称/别名', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(alias)) skillInvalid('技能名称/别名只能使用小写字母、数字和单个连字符');
  return alias;
}
export function skillPath(value: unknown): string {
  const path = skillText(value, '文件路径', 240);
  const hasControl = [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (value !== path || path !== path.normalize('NFC') || path.includes('\\') || path.startsWith('/') || hasControl || /[<>:"|?*]/.test(path)) skillInvalid('技能文件必须使用安全的相对路径');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) || /^\.git$/i.test(part))) skillInvalid('技能路径包含保留名称或越界路径');
  return path;
}
export function skillHash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Parse the required scalar fields without evaluating YAML tags, aliases, or package code. */
function metadata(markdown: string) {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const frontmatter = match?.[1];
  if (frontmatter === undefined) skillInvalid('SKILL.md 必须以 YAML frontmatter 开始，并包含 name 与 description');
  const lines = frontmatter.split('\n'); const values = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1] ?? ''; let value = (field[2] ?? '').trim();
    if (values.has(key)) skillInvalid(`SKILL.md 的 ${key} 不得重复`);
    if (/^[|>][-+]?$/.test(value)) {
      const folded = value[0] === '>'; const chunks: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1] ?? '') || lines[index + 1] === '')) chunks.push((lines[++index] ?? '').trim());
      value = chunks.join(folded ? ' ' : '\n').trim();
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { skillInvalid(`SKILL.md 的 ${key} 引号无效`); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) skillInvalid(`SKILL.md 的 ${key} 引号无效`);
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      if (['!', '&', '*', '[', '{'].includes(value.charAt(0))) skillInvalid(`SKILL.md 的 ${key} 必须是文本`);
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.set(key, skillText(value, key, key === 'name' ? 64 : 1024));
  }
  return { name: skillAlias(values.get('name')), description: skillText(values.get('description'), 'description', 1024) };
}

export function normalizeSkillPackage(input: unknown): SkillPackage {
  if (!Array.isArray(input) || input.length === 0 || input.length > SKILL_MAX_FILES) skillInvalid(`技能包必须包含 1–${SKILL_MAX_FILES} 个文件`);
  const files: SkillFile[] = []; let size = 0; const paths = new Set<string>(); const spellings = new Map<string, string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') skillInvalid('技能文件无效');
    const file = item as Record<string, unknown>;
    if ('symlink' in file || 'link_target' in file || ('type' in file && file.type !== 'file')) skillInvalid('技能包不支持符号链接或特殊文件');
    const path = skillPath(file.path); const key = path.toLowerCase();
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/'); const lower = prefix.toLowerCase();
      if (spellings.has(lower) && spellings.get(lower) !== prefix) skillInvalid('技能包包含大小写冲突的目录路径');
      spellings.set(lower, prefix);
    }
    if (paths.has(key)) skillInvalid('技能包包含大小写重复的路径'); paths.add(key);
    if (typeof file.content_base64 !== 'string' || file.content_base64.length > Math.ceil(SKILL_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) skillInvalid('文件内容不是有效 Base64');
    const bytes = Buffer.from(file.content_base64, 'base64'); size += bytes.length;
    if (bytes.toString('base64') !== file.content_base64) skillInvalid('文件 Base64 编码不规范');
    if (size > SKILL_MAX_BYTES) skillInvalid('技能包总大小不能超过 6 MiB');
    const sha256 = skillHash(bytes);
    if (file.size_bytes !== undefined && file.size_bytes !== bytes.length) skillInvalid('文件大小校验失败');
    if (file.sha256 !== undefined && file.sha256 !== sha256) skillInvalid('文件 SHA-256 校验失败');
    files.push({ path, content_base64: bytes.toString('base64'), size_bytes: bytes.length, sha256 });
  }
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (paths.has(parts.join('/'))) skillInvalid('文件与父目录路径冲突'); parts.pop(); }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entry = files.find(file => file.path === 'SKILL.md');
  if (!entry) skillInvalid('技能包缺少根目录 SKILL.md');
  let markdown: string;
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(entry.content_base64, 'base64')); } catch { skillInvalid('SKILL.md 必须是 UTF-8 文本'); }
  return { ...metadata(markdown), files, size_bytes: size, package_sha256: skillHash(JSON.stringify(files.map(file => [file.path, file.sha256, file.size_bytes]))) };
}

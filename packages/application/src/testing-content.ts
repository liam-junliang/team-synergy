import { createHash } from 'node:crypto';
import { DomainError } from '@team-synergy/domain';
import type { TestAssetContent, TestCaseContent, TestFile } from '@team-synergy/contracts';

export function invalid(message: string): never { throw new DomainError('testing_invalid', message); }
export function testText(value: unknown, field: string, max = 65536, required = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) invalid(`${field} 格式或长度不正确`);
  return value;
}
export function testChoice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (!choices.includes(value as T)) invalid(`${field} 不支持该值`);
  return value as T;
}
export function testStrings(value: unknown, field: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${field} 必须是数组，最多 ${max} 项`);
  return [...new Set(value.map(item => testText(item, field, 512, true).trim()))];
}
export function testRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('revision 必须为正整数');
  return value as number;
}
export function testUrl(value: unknown): string {
  const raw = testText(value, 'URL', 4096, true).trim();
  try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('仅支持不含凭据的 HTTP(S) URL'); }
  catch { invalid('URL 不正确'); }
  return raw;
}
export function testCommit(value: unknown): string {
  const commit = testText(value, 'commit', 64).trim();
  if (commit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commit)) invalid('commit 必须是完整的 40 或 64 位 Git commit SHA');
  return commit.toLowerCase();
}
function file(value: unknown): TestFile {
  if (!value || typeof value !== 'object') invalid('请提供文件内容');
  const input = value as Record<string, unknown>;
  const file_name = testText(input.file_name, '文件名', 255, true);
  if (/[\\/]/.test(file_name) || Array.from(file_name).some(character => character.charCodeAt(0) < 32) || ['.', '..'].includes(file_name)) invalid('文件名不能包含路径或控制字符');
  const mime_type = testText(input.mime_type ?? 'application/octet-stream', 'MIME', 255, true);
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime_type)) invalid('MIME 类型不正确');
  const content_base64 = testText(input.content_base64, '文件内容', 8 * 1024 * 1024);
  if (content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64)) invalid('文件内容必须是有效 base64');
  const bytes = Buffer.from(content_base64, 'base64');
  if (bytes.length > 6 * 1024 * 1024 || bytes.toString('base64') !== content_base64) invalid('文件超过 6 MiB 或编码不正确');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (input.size_bytes !== undefined && input.size_bytes !== bytes.length) invalid('文件大小与内容不匹配');
  if (input.sha256 !== undefined && input.sha256 !== sha256) invalid('文件校验值与内容不匹配');
  return { file_name, mime_type, content_base64, size_bytes: bytes.length, sha256 };
}
export function withoutTestFileBytes<T extends { file: TestFile | null }>(content: T): Omit<T, 'file'> & { file: Omit<TestFile, 'content_base64'> | null } {
  const { file: data, ...rest } = content;
  return { ...rest, file: data ? { file_name: data.file_name, mime_type: data.mime_type, size_bytes: data.size_bytes, sha256: data.sha256 } : null };
}
function common(input: Record<string, unknown>) {
  return { title: testText(input.title, '标题', 512, true).trim(), summary: testText(input.summary ?? '', '摘要', 4096),
    module_code: input.module_code == null ? null : testText(input.module_code, '模块', 20, true),
    requirement_codes: testStrings(input.requirement_codes ?? [], '需求'), tags: testStrings(input.tags ?? [], '标签', 30) };
}
export function normalizeTestCase(input: Record<string, unknown>): TestCaseContent {
  const steps = input.steps ?? [];
  if (!Array.isArray(steps) || steps.length > 200) invalid('步骤最多 200 项');
  return { ...common(input), priority: testChoice(input.priority ?? 'medium', ['low', 'medium', 'high', 'critical'], '优先级'),
    method: testChoice(input.method ?? 'manual', ['manual', 'automated'], '测试方式'), suite: testText(input.suite ?? '', '套件', 255),
    preconditions: testText(input.preconditions ?? '', '前置条件'), notes_markdown: testText(input.notes_markdown ?? '', '说明'),
    asset_codes: testStrings(input.asset_codes ?? [], '测试资料'),
    steps: steps.map(step => { if (!step || typeof step !== 'object') invalid('步骤格式不正确'); return {
      action: testText(step.action, '操作步骤', 8192, true), expected: testText(step.expected ?? '', '预期结果', 8192),
    }; }),
  };
}
export function normalizeTestAsset(input: Record<string, unknown>): TestAssetContent {
  const storage_kind = testChoice(input.storage_kind ?? 'markdown', ['markdown', 'file', 'url', 'git'], '存储方式');
  const result: TestAssetContent = { ...common(input), storage_kind,
    purpose: testChoice(input.purpose ?? 'guide', ['guide', 'script', 'data', 'environment', 'report'], '资料用途'),
    content: testText(input.content ?? '', '资料说明', 2 * 1024 * 1024), url: null, file: null, git: null };
  if (storage_kind === 'file') result.file = file(input.file);
  if (storage_kind === 'url') result.url = testUrl(input.url);
  if (storage_kind === 'git') {
    if (!input.git || typeof input.git !== 'object') invalid('请提供 Git 引用');
    const git = input.git as Record<string, unknown>;
    const path = testText(git.path ?? '', '仓库路径', 2048);
    if (/^[\\/]|^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) invalid('必须使用仓库内相对路径');
    result.git = { repository_code: testText(git.repository_code, '仓库', 20, true), path,
      ref: testText(git.ref ?? '', 'Git ref', 512), commit: testCommit(git.commit ?? ''),
      command: testText(git.command ?? '', '运行命令', 8192), setup: testText(git.setup ?? '', '准备说明') };
  }
  return result;
}

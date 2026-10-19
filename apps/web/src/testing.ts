import type { TestAssetContent, TestAssetDetail, TestCaseContent, TestExecutionAsset, TestFile } from './api';
export const TEST_RESULT_LABELS = { not_run: '未执行', pass: '通过', fail: '失败', blocked: '阻塞', skipped: '跳过' } as const;
export const TEST_PRIORITY_LABELS = { low: '低', medium: '中', high: '高', critical: '紧急' } as const;
export const TEST_METHOD_LABELS = { manual: '手工', automated: '自动化' } as const;
export const TEST_PURPOSE_LABELS = { guide: '测试说明', script: '测试脚本', data: '测试数据', environment: '测试环境', report: '测试报告' } as const;
export const TEST_STORAGE_LABELS = { markdown: 'Markdown', file: '文件', url: 'URL 链接', git: 'Git 仓库' } as const;
export function testCaseDraft(initial?: TestCaseContent): TestCaseContent {
  return initial ? { title: initial.title, summary: initial.summary, module_code: initial.module_code, requirement_codes: [...initial.requirement_codes], priority: initial.priority, method: initial.method, suite: initial.suite, tags: [...initial.tags], preconditions: initial.preconditions, steps: initial.steps.map(step => ({ ...step })), notes_markdown: initial.notes_markdown, asset_codes: [...initial.asset_codes] } : { title: '', summary: '', module_code: null, requirement_codes: [], priority: 'medium', method: 'manual', suite: '', tags: [], preconditions: '', steps: [{ action: '', expected: '' }], notes_markdown: '', asset_codes: [] };
}
export function testAssetDraft(initial?: TestAssetContent): TestAssetContent {
  return initial ? { title: initial.title, summary: initial.summary, purpose: initial.purpose, storage_kind: initial.storage_kind, content: initial.content, url: initial.url, file: initial.file, git: initial.git ? { ...initial.git } : null, module_code: initial.module_code, requirement_codes: [...initial.requirement_codes], tags: [...initial.tags] } : { title: '', summary: '', purpose: 'guide', storage_kind: 'markdown', content: '', url: null, file: null, git: null, module_code: null, requirement_codes: [], tags: [] };
}
export function testAssetWriteContent(draft: TestAssetContent): TestAssetContent {
  return { ...draft, url: draft.storage_kind === 'url' ? draft.url : null, file: draft.storage_kind === 'file' ? draft.file : null, git: draft.storage_kind === 'git' ? draft.git : null };
}
export function safeTestUrl(value: string | null | undefined): string | undefined {
  if (!value) return;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return; }
}
export function splitTestTags(value: string): string[] { return [...new Set(value.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))]; }
export function testFileBytes(file: TestFile): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(file.content_base64), character => character.charCodeAt(0)); }
export function testFilePreview(file: TestFile | null): string | undefined {
  if (!file || file.size_bytes > 256 * 1024 || !(/^(text\/|application\/(json|xml|javascript|x-yaml))/.test(file.mime_type) || /\.(md|txt|json|ya?ml|[cm]?js|ts|py|sh|ps1|sql|csv|xml)$/i.test(file.file_name))) return;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(testFileBytes(file)); } catch { return; }
}
export async function readTestFile(file: File): Promise<TestFile> {
  if (file.size > 6 * 1024 * 1024) throw new Error('文件大小不能超过 6 MiB。');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  // LAN HTTP may lack SubtleCrypto. The API always computes and validates the persisted digest.
  const digest = globalThis.crypto?.subtle ? await globalThis.crypto.subtle.digest('SHA-256', buffer) : null;
  return { file_name: file.name, mime_type: file.type || 'application/octet-stream', size_bytes: file.size, content_base64: btoa(binary), sha256: digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : '' };
}
export function testExecutionFile(asset: TestExecutionAsset, detail: TestAssetDetail): TestFile | undefined {
  if (detail.code !== asset.asset_code) return;
  const file = detail.revisions.find(item => item.revision === asset.revision)?.file;
  return file && asset.snapshot.file && file.sha256 === asset.snapshot.file.sha256 ? file : undefined;
}
export function downloadTestFile(file: TestFile) {
  const url = URL.createObjectURL(new Blob([testFileBytes(file)], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = file.file_name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

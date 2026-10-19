import type { SkillFileInput } from './api';

export const SKILL_STARTER = '---\nname: project-guide\ndescription: Explain when to use this skill and the outcome it produces.\n---\n\n# Project guide\n\n## Steps\n\n1. Read the project context.\n2. Follow the agreed workflow.\n3. Report evidence and unresolved questions.\n';
export function skillTextFile(path: string, text: string): SkillFileInput {
  return { path, content_base64: bytesBase64(new TextEncoder().encode(text)) };
}
function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function skillFileText(file: SkillFileInput): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(file.content_base64), character => character.charCodeAt(0));
    if (bytes.length > 512 * 1024 || bytes.includes(0)) return;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return; }
}
export function validSkillPath(path: string): boolean {
  return Boolean(path) && path === path.trim() && path === path.normalize('NFC') && path.length <= 240 && !/^[\\/]|[\\<>:"|?*]/.test(path) && !Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith(' ') && !part.endsWith('.') && !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) && !/^\.git$/i.test(part));
}
/** Directory imports preserve bytes. Root stripping applies only to browser directory selections. */
export async function readSkillFiles(files: File[]): Promise<SkillFileInput[]> {
  if (!files.length || files.length > 200) throw new Error('技能包需要 1–200 个文件。');
  const directory = files.every(file => Boolean(file.webkitRelativePath));
  const inputs: SkillFileInput[] = [];
  let total = 0;
  for (const file of files) {
    const path = directory ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    if (!validSkillPath(path)) throw new Error('技能包包含不安全或无效的相对路径。');
    total += file.size;
    if (total > 6 * 1024 * 1024) throw new Error('技能包总大小不能超过 6 MiB。');
    inputs.push({ path, content_base64: bytesBase64(new Uint8Array(await file.arrayBuffer())) });
  }
  if (!inputs.some(file => file.path === 'SKILL.md')) throw new Error('技能包根目录必须包含 SKILL.md。');
  if (new Set(inputs.map(file => file.path.toLowerCase())).size !== inputs.length) throw new Error('技能包存在重复或大小写冲突的路径。');
  return inputs;
}
export function skillFileChanges(current: SkillFileInput[], previous: SkillFileInput[]): Array<{ path: string; kind: 'added' | 'changed' | 'removed' }> {
  const old = new Map(previous.map(file => [file.path, file.content_base64]));
  const next = new Map(current.map(file => [file.path, file.content_base64]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap<{ path: string; kind: 'added' | 'changed' | 'removed' }>(path => !old.has(path) ? [{ path, kind: 'added' as const }] : !next.has(path) ? [{ path, kind: 'removed' as const }] : old.get(path) !== next.get(path) ? [{ path, kind: 'changed' as const }] : []);
}

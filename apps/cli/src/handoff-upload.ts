import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type InferredHandoffKind = 'doc' | 'api' | 'diagram';

export interface HandoffUploadDirectory {
  relative_path: string;
  parent_relative_path: string | null;
  name: string;
}

export interface HandoffUploadDocument {
  absolute_path: string;
  relative_path: string;
  parent_relative_path: string | null;
  title: string;
  summary: string;
  inferred_kind: InferredHandoffKind;
}

export interface HandoffUploadPlan {
  source_path: string;
  source_type: 'file' | 'directory';
  root_name: string;
  directories: HandoffUploadDirectory[];
  documents: HandoffUploadDocument[];
}

const supportedExtensions = new Set(['.md', '.markdown', '.txt']);
const ignoredDirectoryNames = new Set(['.git', '.agent', '.omx', 'node_modules', 'dist', 'build', 'coverage']);

function documentTitle(filePath: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(filePath, path.extname(filePath));
}

function documentSummary(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#') && !item.startsWith('```'));
  return line ? line.replace(/^[-*>]\s*/, '').slice(0, 160) : '';
}

export function inferHandoffKind(relativePath: string, content = ''): InferredHandoffKind {
  const value = relativePath.toLowerCase();
  if (/(接口|(^|[\\/_.\-\s])(api|openapi|swagger)([\\/_.\-\s]|$))/i.test(value)) return 'api';
  if (/(架构图|流程图|时序图|(^|[\\/_.\-\s])(diagram|diagrams)([\\/_.\-\s]|$))/i.test(value)
    || /^\s{0,3}(?:`{3,}|~{3,})mermaid\s*$/im.test(content)) return 'diagram';
  return 'doc';
}

export function collectHandoffUploadPlan(inputPath: string): HandoffUploadPlan {
  const sourcePath = path.resolve(inputPath);
  const sourceStat = lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) throw new Error(`不支持上传符号链接：${sourcePath}`);

  if (sourceStat.isFile()) {
    if (!supportedExtensions.has(path.extname(sourcePath).toLowerCase())) {
      throw new Error('项目文档仅支持 .md、.markdown 或 .txt 文件；Mermaid、draw.io 和图片图源请使用 tsp architecture create');
    }
    const content = readFileSync(sourcePath, 'utf8');
    return {
      source_path: sourcePath,
      source_type: 'file',
      root_name: path.basename(sourcePath),
      directories: [],
      documents: [{
        absolute_path: sourcePath,
        relative_path: path.basename(sourcePath),
        parent_relative_path: null,
        title: documentTitle(sourcePath, content),
        summary: documentSummary(content),
        inferred_kind: inferHandoffKind(path.basename(sourcePath), content),
      }],
    };
  }

  if (!sourceStat.isDirectory()) throw new Error(`上传路径不是文件或文件夹：${sourcePath}`);

  const directories: HandoffUploadDirectory[] = [];
  const documents: HandoffUploadDocument[] = [];

  function visit(directoryPath: string, relativeDirectory: string): void {
    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || ignoredDirectoryNames.has(entry.name)) continue;
        directories.push({
          relative_path: relativePath,
          parent_relative_path: relativeDirectory || null,
          name: entry.name,
        });
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !supportedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const content = readFileSync(absolutePath, 'utf8');
      documents.push({
        absolute_path: absolutePath,
        relative_path: relativePath,
        parent_relative_path: relativeDirectory || null,
        title: documentTitle(absolutePath, content),
        summary: documentSummary(content),
        inferred_kind: inferHandoffKind(relativePath, content),
      });
    }
  }

  visit(sourcePath, '');
  return {
    source_path: sourcePath,
    source_type: 'directory',
    root_name: path.basename(sourcePath),
    directories,
    documents,
  };
}

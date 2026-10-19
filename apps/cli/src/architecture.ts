import type { Command } from 'commander';
import { DomainError } from '@team-synergy/domain';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiResult, createApiClient } from './api-client.js';

type ArchitectureKind = 'mermaid' | 'drawio' | 'image';
type FileOptions = { file?: string; kind?: string; title?: string; summary?: string; notesFile?: string; previewFile?: string; clearPreview?: boolean };
interface CommandContext {
  requireApiClient: () => ReturnType<typeof createApiClient>;
  resolveProjectCode: (explicit?: string) => Promise<string>;
  printResult: (result: ApiResult<unknown>) => void;
  failResult: (error: unknown) => { ok: false; error: { code: string; message: string; details?: unknown } };
}

function positiveRevision(value: string): number {
  const revision = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(revision)) {
    throw new DomainError('architecture_revision_invalid', 'Revision 必须是正整数');
  }
  return revision;
}

function readLimitedFile(file: string, limit: number): Buffer {
  const absolute = path.resolve(file);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > limit) throw new DomainError('architecture_file_invalid', `文件不得超过 ${limit / 1024 / 1024} MiB`);
  return readFileSync(absolute);
}

function inputFromFiles(opts: FileOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.kind && !opts.file) throw new DomainError('architecture_source_required', '指定 --kind 时必须同时提供 --file');
  if (opts.file) {
    const extension = path.extname(opts.file).toLowerCase();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extension];
    const kind = opts.kind ?? (mime ? 'image' : ['.drawio', '.xml'].includes(extension) ? 'drawio' : ['.mmd', '.mermaid'].includes(extension) ? 'mermaid' : undefined);
    if (!kind || !['mermaid', 'drawio', 'image'].includes(kind)) {
      throw new DomainError('architecture_kind_invalid', '请使用 .mmd、.drawio 或图片文件，或指定 --kind mermaid/drawio/image');
    }
    const bytes = readLimitedFile(opts.file, 6 * 1024 * 1024);
    if (kind === 'image' && !mime) throw new DomainError('architecture_image_invalid', '图片仅支持 PNG、JPEG、WebP');
    body.content_kind = kind as ArchitectureKind;
    body.source_content = kind === 'image' ? `data:${mime};base64,${bytes.toString('base64')}` : bytes.toString('utf8');
    if (Buffer.byteLength(String(body.source_content), 'utf8') > 6 * 1024 * 1024) {
      throw new DomainError('architecture_source_too_large', '编码后的图源不能超过 6 MiB');
    }
  }
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.summary !== undefined) body.summary = opts.summary;
  if (opts.notesFile !== undefined) body.notes_markdown = readLimitedFile(opts.notesFile, 256 * 1024).toString('utf8');
  if (opts.clearPreview && opts.previewFile) throw new DomainError('architecture_preview_invalid', '--clear-preview 和 --preview-file 不能同时使用');
  if (opts.previewFile) body.preview_svg = readLimitedFile(opts.previewFile, 2 * 1024 * 1024).toString('utf8');
  else if (opts.clearPreview) body.preview_svg = null;
  return body;
}

export function registerArchitectureCommands(program: Command, context: CommandContext): void {
  const architecture = program.command('architecture').description('项目架构图源与版本：list / show / create / revise');
  const run = async (action: () => Promise<ApiResult<unknown>>) => {
    try {
      const result = await action();
      context.printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      context.printResult(context.failResult(error));
      process.exitCode = 1;
    }
  };

  architecture.command('list').description('查看项目架构资料索引，支持关键词检索')
    .option('--project <project_code>', '项目编码；默认使用当前目录绑定')
    .option('--query <query>', '标题或摘要关键词')
    .action((opts: { project?: string; query?: string }) => run(async () =>
      context.requireApiClient().listArchitectureDocuments(await context.resolveProjectCode(opts.project), opts.query)));

  architecture.command('show').description('读取图源、说明和历史；可导出指定版本的原始图源')
    .argument('<document_code>').option('--revision <revision>', '指定历史版本；默认当前版本')
    .option('--output <path>', '图源保存路径（图片导出原始字节）').option('--force', '覆盖已有输出文件')
    .action((code: string, opts: { revision?: string; output?: string; force?: boolean }) => run(async () => {
      const revision = opts.revision === undefined ? undefined : positiveRevision(opts.revision);
      const output = opts.output ? path.resolve(opts.output) : undefined;
      if (output && existsSync(output) && !opts.force) throw new DomainError('output_exists', '输出文件已存在；请使用新路径或 --force');
      const result = await context.requireApiClient().getArchitectureDocument(code);
      if (!result.ok) return result;
      let data = result.data;
      if (revision !== undefined) {
        const historical = Array.isArray(data.revisions)
          ? data.revisions.find((item: unknown) => typeof item === 'object' && item !== null && 'revision' in item && item.revision === revision) as Record<string, unknown> | undefined
          : undefined;
        if (!historical) throw new DomainError('architecture_revision_not_found', `不存在 Revision ${revision}`);
        data = { ...data, ...historical, selected_revision: revision };
      }
      if (output) {
        if (typeof data.source_content !== 'string') throw new DomainError('api_bad_response', '架构响应缺少图源');
        let bytes: Buffer;
        if (data.content_kind === 'image') {
          const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.source_content);
          if (!match?.[1]) throw new DomainError('api_bad_response', '图片图源格式无效');
          bytes = Buffer.from(match[1], 'base64');
        } else bytes = Buffer.from(data.source_content, 'utf8');
        writeFileSync(output, bytes, { flag: opts.force ? 'w' : 'wx' });
        data = { ...data, exported_path: output };
      }
      return { ok: true, data };
    }));

  function sourceOptions(command: Command): Command {
    return command.option('--kind <kind>', 'mermaid / drawio / image；默认按文件扩展名识别')
      .option('--summary <summary>', '用途摘要').option('--notes-file <path>', '架构说明 Markdown 文件')
      .option('--preview-file <path>', '与本次图源对应的 SVG 预览文件');
  }
  sourceOptions(architecture.command('create').description('上传架构图源，保存第一个版本')
    .requiredOption('--title <title>', '标题').requiredOption('--file <path>', 'Mermaid、draw.io XML 或图片')
    .option('--project <project_code>', '项目编码；默认使用当前目录绑定'))
    .action((opts: FileOptions & { project?: string }) => run(async () => {
      const body = inputFromFiles(opts);
      return context.requireApiClient().createArchitectureDocument(await context.resolveProjectCode(opts.project), body);
    }));

  sourceOptions(architecture.command('revise').description('基于已读取的 Revision 修订；冲突时保留远端数据')
    .argument('<document_code>').requiredOption('--base-revision <revision>', '编辑时读取的当前版本号')
    .requiredOption('--change <summary>', '本次修改说明').option('--file <path>', '新图源；省略则保留原图源')
    .option('--title <title>', '新标题').option('--clear-preview', '清除已有派生预览'))
    .action((code: string, opts: FileOptions & { baseRevision: string; change: string }) => run(async () => {
      const baseRevision = positiveRevision(opts.baseRevision);
      return context.requireApiClient().reviseArchitectureDocument(code, {
        ...inputFromFiles(opts), base_revision: baseRevision, change_summary: opts.change,
      });
    }));
}

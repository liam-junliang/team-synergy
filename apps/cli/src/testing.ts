import type { Command } from 'commander';
import { DomainError } from '@team-synergy/domain';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiResult, createApiClient } from './api-client.js';

interface Context {
  requireApiClient: () => ReturnType<typeof createApiClient>;
  resolveProjectCode: (explicit?: string) => Promise<string>;
  printResult: (result: ApiResult<unknown>) => void;
  failResult: (error: unknown) => { ok: false; error: { code: string; message: string; details?: unknown } };
}
type Input = Record<string, unknown>;
type SourceOptions = {
  input?: string; file?: string; kind?: string; url?: string; gitFile?: string;
  title?: string; summary?: string; purpose?: string; notesFile?: string; mime?: string;
};
const MAX_FILE_BYTES = 6 * 1024 * 1024;

function readFile(file: string, limit = MAX_FILE_BYTES): Buffer {
  const absolute = path.resolve(file);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > limit) {
    throw new DomainError('testing_file_invalid', `文件必须是普通文件且不超过 ${limit} 字节`);
  }
  const bytes = readFileSync(absolute);
  if (bytes.length > limit) throw new DomainError('testing_file_invalid', `文件不超过 ${limit} 字节`);
  return bytes;
}

function readJson(file: string): Input {
  let parsed: unknown;
  try { parsed = JSON.parse(readFile(file, 9 * 1024 * 1024).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DomainError('testing_json_invalid', '输入文件必须是有效 JSON');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('testing_json_invalid', '输入必须是 JSON 对象');
  return parsed as Input;
}

function revision(value: string): number {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) throw new DomainError('testing_revision_invalid', '版本号必须是正整数');
  return number;
}

function selectRevision(data: Input, value?: string): Input {
  if (value === undefined) return data;
  const selected = revision(value);
  const historical = Array.isArray(data.revisions) ? data.revisions.find((item: unknown) =>
    item && typeof item === 'object' && 'revision' in item && item.revision === selected) as Input | undefined : undefined;
  if (!historical) throw new DomainError('testing_revision_not_found', `不存在 Revision ${selected}`);
  return { ...data, ...historical, selected_revision: selected };
}

function assetInput(opts: SourceOptions): Input {
  const body: Input = opts.input ? readJson(opts.input) : {};
  if ([opts.file, opts.url, opts.gitFile].filter(value => value !== undefined).length > 1) {
    throw new DomainError('testing_source_invalid', '--file、--url 和 --git-file 只能选择一个');
  }
  if (opts.kind && !['markdown', 'file', 'url', 'git'].includes(opts.kind)) throw new DomainError('testing_source_invalid', '--kind 必须是 markdown / file / url / git');
  if (opts.file !== undefined) {
    const kind = opts.kind ?? (/\.(md|markdown)$/i.test(opts.file) ? 'markdown' : 'file');
    if (!['markdown', 'file'].includes(kind)) throw new DomainError('testing_source_invalid', '--file 仅支持 markdown 或 file');
    const bytes = readFile(opts.file);
    Object.assign(body, { storage_kind: kind, url: null, git: null, file: null });
    if (kind === 'markdown') body.content = bytes.toString('utf8');
    else body.file = {
      file_name: path.basename(opts.file), mime_type: opts.mime ?? 'application/octet-stream',
      content_base64: bytes.toString('base64'), size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } else if (opts.url !== undefined) {
    if (opts.kind && opts.kind !== 'url') throw new DomainError('testing_source_invalid', '--url 必须使用 url 类型');
    Object.assign(body, { storage_kind: 'url', url: opts.url, file: null, git: null });
  } else if (opts.gitFile !== undefined) {
    if (opts.kind && opts.kind !== 'git') throw new DomainError('testing_source_invalid', '--git-file 必须使用 git 类型');
    Object.assign(body, { storage_kind: 'git', git: readJson(opts.gitFile), file: null, url: null });
  } else if (opts.kind !== undefined) {
    if (!opts.input) throw new DomainError('testing_source_invalid', '--kind 需要同时提供来源文件、链接或 --input');
    body.storage_kind = opts.kind;
  }
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.summary !== undefined) body.summary = opts.summary;
  if (opts.purpose !== undefined) body.purpose = opts.purpose;
  if (opts.notesFile !== undefined) {
    if (body.storage_kind === 'markdown' && opts.file) throw new DomainError('testing_source_invalid', 'Markdown 正文请使用 --file，不能同时使用 --notes-file');
    body.content = readFile(opts.notesFile).toString('utf8');
  }
  return body;
}

function assetBytes(data: Input): Buffer {
  if (data.storage_kind === 'markdown' && typeof data.content === 'string') return Buffer.from(data.content, 'utf8');
  if (data.storage_kind !== 'file') throw new DomainError('testing_download_unsupported', '仅可下载 Markdown 正文或文件附件；Git 和 URL 请读取来源信息');
  const file = data.file as Input | null;
  if (!file || typeof file.content_base64 !== 'string' || file.content_base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) {
    throw new DomainError('api_bad_response', '附件内容无效');
  }
  const bytes = Buffer.from(file.content_base64, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.length !== file.size_bytes
    || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new DomainError('api_bad_response', '附件大小或 SHA-256 校验失败');
  return bytes;
}

export function registerTestingCommands(program: Command, context: Context): void {
  const testing = program.command('test').description('测试用例、资料与执行记录；脚本由本机 Agent 或 CI 执行');
  const run = async (action: () => Promise<ApiResult<unknown>>) => {
    try { const result = await action(); context.printResult(result); if (!result.ok) process.exitCode = 1; }
    catch (error) { context.printResult(context.failResult(error)); process.exitCode = 1; }
  };
  const call = (method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown) => context.requireApiClient().testingRequest(method, route, body);
  const code = encodeURIComponent;
  const groups = { case: testing.command('case').description('结构化、版本化测试用例'), asset: testing.command('asset').description('测试说明、脚本、数据、环境与报告资料') };
  for (const kind of ['case', 'asset'] as const) {
    const group = groups[kind];
    for (const action of ['list', 'search'] as const) {
      const command = group.command(action === 'search' ? 'search <query>' : 'list')
        .description(action === 'search' ? '搜索正文、步骤和元数据；不返回附件字节' : '列出项目测试索引')
        .option('--project <project_code>', '默认当前目录绑定的项目')
        .option('--query <query>', '关键词');
      if (kind === 'case') command.option('--module <module_code>', '功能模块').option('--requirement <requirement_code>', '关联需求').option('--suite <suite>', '套件名称').option('--method <method>', 'manual / automated');
      else command.option('--purpose <purpose>', 'guide / script / data / environment / report').option('--kind <kind>', 'markdown / file / url / git');
      command.action((...args: unknown[]) => run(async () => {
        const opts = args[action === 'search' ? 1 : 0] as Record<string, string | undefined>;
        const query = action === 'search' ? args[0] as string : opts.query;
        const filters = new URLSearchParams();
        for (const [key, value] of Object.entries({ q: query, module_code: opts.module, requirement_code: opts.requirement, suite: opts.suite, method: opts.method, purpose: opts.purpose, storage_kind: opts.kind })) if (value !== undefined) filters.set(key, value);
        return call('GET', `/projects/${code(await context.resolveProjectCode(opts.project))}/test-${kind}s${filters.size ? `?${filters}` : ''}`);
      }));
    }
    group.command('show <code>').description('读取完整内容与历史；指定版本时显示当时的内容')
      .option('--revision <revision>', '历史版本；默认当前版本')
      .action((value: string, opts: { revision?: string }) => run(async () => {
        if (opts.revision !== undefined) revision(opts.revision);
        const result = await call('GET', `/test-${kind}s/${code(value)}`);
        return result.ok ? { ok: true, data: selectRevision(result.data, opts.revision) } : result;
      }));
  }
  for (const action of ['create', 'revise'] as const) {
    const command = groups.case.command(action === 'create' ? action : `${action} <code>`)
      .description(action === 'create' ? '从 JSON 创建测试用例' : '通过 JSON 修订；省略字段保留原值')
      .requiredOption('--file <path>', '用例 JSON 文件').option('--notes-file <path>', '补充说明 Markdown');
    if (action === 'create') command.option('--project <project_code>', '默认当前目录绑定的项目');
    else command.requiredOption('--base-revision <revision>', '编辑时读取的当前版本号').requiredOption('--change <summary>', '修改说明');
    command.action((...args: unknown[]) => run(async () => {
      const opts = args[action === 'create' ? 0 : 1] as { file: string; notesFile?: string; project?: string; baseRevision: string; change: string };
      const body = readJson(opts.file);
      if (opts.notesFile !== undefined) body.notes_markdown = readFile(opts.notesFile).toString('utf8');
      if (action === 'revise') Object.assign(body, { base_revision: revision(opts.baseRevision), change_summary: opts.change });
      return call(action === 'create' ? 'POST' : 'PATCH', action === 'create' ? `/projects/${code(await context.resolveProjectCode(opts.project))}/test-cases` : `/test-cases/${code(args[0] as string)}`, body);
    }));
    const assetCommand = groups.asset.command(action === 'create' ? action : `${action} <code>`)
      .description(action === 'create' ? '保存测试资料与第一个版本' : '修订资料，保留历史文件和来源')
      .option('--input <path>', '完整或部分资料 JSON 对象')
      .option('--title <title>', '标题').option('--summary <summary>', '用途摘要')
      .option('--purpose <purpose>', 'guide / script / data / environment / report')
      .option('--kind <kind>', 'markdown / file / url / git；文件默认按扩展名识别')
      .option('--file <path>', '上传 Markdown、脚本或其他文件，最多 6 MiB')
      .option('--mime <mime>', '附件媒体类型；默认 application/octet-stream')
      .option('--url <url>', '外部资料 HTTP(S) 链接')
      .option('--git-file <path>', 'Git 来源 JSON：repository_code/path/ref/commit/command/setup')
      .option('--notes-file <path>', '资料附带的 Markdown 说明');
    if (action === 'create') assetCommand.option('--project <project_code>', '默认当前目录绑定的项目');
    else assetCommand.requiredOption('--base-revision <revision>', '编辑时读取的当前版本号').requiredOption('--change <summary>', '修改说明');
    assetCommand.action((...args: unknown[]) => run(async () => {
      const opts = args[action === 'create' ? 0 : 1] as SourceOptions & { project?: string; baseRevision: string; change: string };
      const body = assetInput(opts);
      if (action === 'create' && (typeof body.title !== 'string' || !body.title.trim())) throw new DomainError('testing_title_required', '创建资料请提供 --title 或在 --input 中指定 title');
      if (action === 'revise') Object.assign(body, { base_revision: revision(opts.baseRevision), change_summary: opts.change });
      return call(action === 'create' ? 'POST' : 'PATCH', action === 'create' ? `/projects/${code(await context.resolveProjectCode(opts.project))}/test-assets` : `/test-assets/${code(args[0] as string)}`, body);
    }));
  }
  groups.asset.command('download <code>').description('导出指定版本的原始文件或 Markdown；不会执行脚本或拉取仓库')
    .option('--revision <revision>', '历史版本；默认当前版本').requiredOption('--output <path>', '明确指定本机输出文件路径')
    .option('--force', '覆盖已存在的普通文件')
    .action((value: string, opts: { revision?: string; output: string; force?: boolean }) => run(async () => {
      if (opts.revision !== undefined) revision(opts.revision);
      const output = path.resolve(opts.output);
      const existing = lstatSync(output, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isFile()) throw new DomainError('output_invalid', '输出位置必须是普通文件，不能是目录或符号链接');
        if (!opts.force) throw new DomainError('output_exists', '输出文件已存在；请换路径或使用 --force');
      }
      const result = await call('GET', `/test-assets/${code(value)}`);
      if (!result.ok) return result;
      const data = selectRevision(result.data, opts.revision);
      const bytes = assetBytes(data);
      writeFileSync(output, bytes, { flag: opts.force ? 'w' : 'wx' });
      return { ok: true, data: { code: value, selected_revision: data.selected_revision ?? data.current_revision, exported_path: output, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
    }));
  const execution = testing.command('execution').description('不可变测试执行记录；不替代任务验收或关闭任务');
  execution.command('list').option('--project <project_code>', '默认当前目录绑定的项目').option('--query <query>', '标题或环境关键词')
    .action((opts: { project?: string; query?: string }) => run(async () => call('GET', `/projects/${code(await context.resolveProjectCode(opts.project))}/test-executions${opts.query ? `?q=${code(opts.query)}` : ''}`)));
  execution.command('show <code>').description('读取执行人、固定版本快照、结果和证据').action((value: string) => run(() => call('GET', `/test-executions/${code(value)}`)));
  execution.command('record').description('从 JSON 记录人工、Agent 或 CI 的执行结果；不会自动运行测试')
    .requiredOption('--file <path>', '执行结果 JSON，包含固定 case_revision 和 asset_refs')
    .option('--project <project_code>', '默认当前目录绑定的项目')
    .action((opts: { file: string; project?: string }) => run(async () => {
      const body = readJson(opts.file);
      return call('POST', `/projects/${code(await context.resolveProjectCode(opts.project))}/test-executions`, body);
    }));
  execution.command('defect <execution_code> <result_code>').description('给失败结果关联已有缺陷或创建缺陷；复现与证据来自保存的结果')
    .option('--defect <defect_code>', '关联同项目已有缺陷')
    .option('--feature <feature_code>', '新建缺陷所属 Feature').option('--title <title>', '新缺陷标题').option('--severity <severity>', '新缺陷严重程度：critical / high / medium / low')
    .action((executionCode: string, resultCode: string, opts: { defect?: string; feature?: string; title?: string; severity?: string }) => run(() => {
      if (opts.defect ? !!(opts.feature || opts.title || opts.severity) : !(opts.feature && opts.title && opts.severity)) throw new DomainError('testing_defect_invalid', '关联使用 --defect；新建需 --feature、--title、--severity，二者不可混用');
      if (opts.severity && !['critical', 'high', 'medium', 'low'].includes(opts.severity)) throw new DomainError('testing_defect_invalid', 'severity 必须是 critical / high / medium / low');
      return call('POST', `/test-executions/${code(executionCode)}/results/${code(resultCode)}/defect`, opts.defect ? { defect_code: opts.defect } : { feature_code: opts.feature, title: opts.title, severity: opts.severity });
    }));
}

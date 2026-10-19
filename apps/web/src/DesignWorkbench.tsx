import { useProjectAccess } from './useProjectAccess';
import { t, getLocale } from './i18n.ts';
import { useLocale } from './useLocale';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDesignPrototype,
  getDesignPrototype,
  getDesignPrototypeFile,
  listDesignPrototypes,
  listRequirements,
  reviseDesignPrototype,
  type DesignPrototypeDetail,
  type DesignPrototypeInput,
  type DesignPrototypeKind,
  type DesignPrototypeStatus,
  type Requirement,
} from './api';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { requirementWorkspacePath } from './workspaceRouting';
import { MarkdownDocument } from './MarkdownDocument';
import { WorkbenchError, WorkbenchLoading } from './RequirementsWorkbench';

const STATUS_META: Record<DesignPrototypeStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-amber-50 text-amber-700 ring-amber-200' },
  ready: { label: '可供开发', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  archived: { label: '已归档', className: 'bg-slate-100 text-slate-500 ring-slate-200' },
};

const PREVIEW_SIZE_PRESETS = [
  { value: 'fit', label: '适应画布', width: null, height: 620 },
  { value: '1440x900', label: '1440 × 900', width: 1440, height: 900 },
  { value: '1024x768', label: '1024 × 768', width: 1024, height: 768 },
  { value: '768x1024', label: '768 × 1024', width: 768, height: 1024 },
  { value: '390x844', label: '390 × 844', width: 390, height: 844 },
] as const;

type PreviewSize = (typeof PREVIEW_SIZE_PRESETS)[number]['value'] | 'custom';

const IMAGE_PROTOTYPE_MARKER = '<meta name="acp-prototype-kind" content="image">';
const CONTENT_LABELS: Record<DesignPrototypeKind, string> = { html: 'HTML', image: '图片', url: 'URL 链接', file: '特殊文件' };

export function designContentKind(detail: Pick<DesignPrototypeDetail, 'content_kind' | 'html_content'>): DesignPrototypeKind {
  if ((!detail.content_kind || detail.content_kind === 'html') && imagePrototypeFromHtml(detail.html_content)) return 'image';
  return detail.content_kind ?? 'html';
}

export function designExternalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function designNotesRevision(detail: DesignPrototypeDetail, notes: string): DesignPrototypeInput {
  return {
    title: detail.title, summary: detail.summary, content_kind: designContentKind(detail),
    html_content: detail.html_content, external_url: detail.external_url ?? undefined,
    file_name: detail.file_name ?? undefined, file_mime_type: detail.file_mime_type ?? undefined,
    notes_markdown: notes, requirement_codes: detail.linked_requirements.map((item) => item.requirement_code),
    status: detail.status, change_summary: t("更新配套设计说明"),
  };
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return t("大小未知");
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}

export function designUploadError(kind: DesignPrototypeKind, file: Pick<File, 'size' | 'type'>): string | null {
  if (kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return t("支持 PNG、JPEG、WebP 或 GIF 图片");
  const limit = kind === 'image' ? 4 : kind === 'file' ? 20 : 6;
  return file.size > limit * 1024 * 1024 ? t("{0}不能超过 {1} MiB", { "0": t(CONTENT_LABELS[kind]), "1": limit }) : null;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function createImagePrototypeHtml(dataUrl: string, alt: string): string {
  const safeUrl = escapeHtmlAttribute(dataUrl);
  const safeAlt = escapeHtmlAttribute(alt.trim() || t("设计原型图片"));
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="UTF-8">${IMAGE_PROTOTYPE_MARKER}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeAlt}</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#eef2f7}body{display:grid;place-items:center;padding:24px}img{display:block;max-width:100%;height:auto;border-radius:12px;background:white;box-shadow:0 18px 48px rgba(15,23,42,.16)}</style></head><body><img src="${safeUrl}" alt="${safeAlt}"></body></html>`;
}

export function imagePrototypeFromHtml(html: string): { dataUrl: string; alt: string } | null {
  if (!html.includes(IMAGE_PROTOTYPE_MARKER)) return null;
  const match = html.match(/<img\s+[^>]*src="(data:image\/(?:png|jpeg|webp|gif);base64,[^"]+)"[^>]*alt="([^"]*)"[^>]*>/i);
  if (!match) return null;
  const decode = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return { dataUrl: decode(match[1]), alt: decode(match[2]) };
}

export const DEFAULT_DESIGN_NOTES = `# 配套设计说明

## 业务逻辑

- 描述页面服务的用户场景、核心操作和业务规则。

## 页面与交互状态

- 列出默认、加载、空、错误、禁用和成功状态。
- 说明关键点击、跳转、弹窗、反馈和响应式变化。

## 数据逻辑

- 说明页面读取、提交和刷新哪些数据，以及必要的字段与状态映射。

## 代码实现提示

- 记录建议复用的组件、路由、接口和实现边界。

## 注意事项

- 补充权限、兼容性、可访问性、性能和暂未覆盖的例外情况。
`;

export const DEFAULT_VISUAL_PROTOTYPE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Team Synergy · 视觉原型</title>
  <style>
    * { box-sizing: border-box; }
    :root { font-family: Inter, "PingFang SC", sans-serif; color: #172033; background: #f4f6fa; }
    body { margin: 0; min-height: 100vh; background: #f4f6fa; }
    button { font: inherit; cursor: pointer; }
    .topbar { height: 62px; display: flex; align-items: center; gap: 26px; padding: 0 24px; color: white; background: #081426; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; white-space: nowrap; }
    .brand-mark { display: grid; grid-template-columns: repeat(2, 6px); gap: 3px; padding: 9px; border-radius: 10px; background: #11a5bd; }
    .brand-mark i { width: 6px; height: 6px; border-radius: 50%; background: white; }
    .nav { display: flex; align-self: stretch; gap: 6px; overflow-x: auto; }
    .nav button { border: 0; border-bottom: 3px solid transparent; padding: 0 11px; color: #9eabc0; background: transparent; font-size: 13px; font-weight: 700; white-space: nowrap; }
    .nav button:hover { color: white; }
    .nav button.active { border-color: #19c2da; color: white; }
    .account { margin-left: auto; display: flex; align-items: center; gap: 8px; color: #cbd5e1; font-size: 12px; }
    .avatar { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 9px; background: #0f8aa4; color: white; font-weight: 800; }
    .app { padding: 26px 28px 38px; }
    .page-head { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
    .eyebrow { margin: 0 0 6px; color: #07849c; font-size: 10px; font-weight: 900; letter-spacing: .18em; }
    h1 { margin: 0; font-size: 25px; letter-spacing: -.02em; }
    .subtitle { margin: 6px 0 0; color: #718096; font-size: 13px; }
    .primary { border: 0; border-radius: 10px; padding: 10px 16px; color: white; background: #087f98; font-weight: 800; box-shadow: 0 6px 16px rgba(8,127,152,.18); }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    .metric { padding: 16px; border: 1px solid #e2e7ef; border-radius: 14px; background: white; box-shadow: 0 3px 10px rgba(15,23,42,.035); }
    .metric span { color: #8491a5; font-size: 11px; }
    .metric strong { display: block; margin-top: 7px; font-size: 24px; }
    .board { display: grid; grid-template-columns: repeat(4, minmax(190px,1fr)); gap: 12px; overflow-x: auto; }
    .column { min-height: 430px; padding: 12px; border-radius: 15px; background: #e9edf3; }
    .column-head { display: flex; justify-content: space-between; margin-bottom: 11px; font-size: 12px; font-weight: 900; }
    .count { display: grid; min-width: 22px; height: 22px; place-items: center; border-radius: 999px; background: white; color: #718096; font-size: 10px; }
    .card { margin-bottom: 9px; padding: 13px; border: 1px solid #e1e6ed; border-radius: 12px; background: white; box-shadow: 0 2px 5px rgba(15,23,42,.06); }
    .tag { display: inline-flex; padding: 3px 7px; border-radius: 6px; color: #087f98; background: #d9f6f8; font-size: 9px; font-weight: 900; }
    .card h3 { margin: 9px 0 12px; font-size: 13px; line-height: 1.5; }
    .card-foot { display: flex; justify-content: space-between; color: #8b97aa; font-size: 10px; }
    .surface { overflow: hidden; border: 1px solid #e1e6ed; border-radius: 15px; background: white; box-shadow: 0 3px 12px rgba(15,23,42,.04); }
    .toolbar { display: flex; gap: 9px; padding: 13px; border-bottom: 1px solid #e7ebf0; }
    .search { flex: 1; min-width: 150px; padding: 10px 12px; border: 1px solid #dce2eb; border-radius: 9px; color: #8290a4; background: #f8fafc; font-size: 12px; }
    .filter { padding: 9px 12px; border: 1px solid #dce2eb; border-radius: 9px; color: #506078; background: white; font-size: 11px; font-weight: 700; }
    .list-row { display: grid; grid-template-columns: 1.5fr .65fr .65fr .55fr; gap: 16px; align-items: center; padding: 15px 16px; border-bottom: 1px solid #edf0f4; font-size: 12px; }
    .list-row.header { color: #8793a6; background: #f8fafc; font-size: 10px; font-weight: 800; letter-spacing: .06em; }
    .status { width: max-content; padding: 4px 8px; border-radius: 999px; color: #08795e; background: #def7ed; font-size: 9px; font-weight: 900; }
    .timeline { position: relative; min-width: 700px; padding: 26px 24px 50px; }
    .timeline::before { content: ''; position: absolute; left: 36px; right: 36px; top: 77px; height: 2px; background: #dce3eb; }
    .milestones { position: relative; display: grid; grid-template-columns: repeat(4,1fr); gap: 20px; }
    .milestone { padding-top: 38px; }
    .milestone::before { content: ''; position: absolute; top: 43px; width: 13px; height: 13px; border: 4px solid white; border-radius: 50%; background: #11a5bd; box-shadow: 0 0 0 2px #11a5bd; }
    .milestone strong { display: block; margin-bottom: 7px; font-size: 13px; }
    .milestone span { color: #8390a4; font-size: 11px; }
    .gallery { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; }
    .shot { overflow: hidden; border: 1px solid #e0e6ee; border-radius: 14px; background: white; }
    .shot-preview { display: grid; height: 150px; place-items: center; background: linear-gradient(135deg,#e8f8fb,#e9edf6); color: #08849d; font-size: 38px; font-weight: 900; }
    .shot-info { padding: 13px; }
    .shot-info strong { display: block; font-size: 13px; }
    .shot-info span { display: block; margin-top: 5px; color: #8a96a7; font-size: 10px; }
    @media (max-width: 760px) { .topbar { padding: 0 14px; gap: 12px; } .brand span, .account span { display: none; } .app { padding: 18px 14px; } .page-head { align-items: start; } .metrics { grid-template-columns: repeat(2,1fr); } .board { grid-template-columns: repeat(4,240px); } .gallery { grid-template-columns: 1fr; } .list-row { grid-template-columns: 1fr .6fr; } .list-row > :nth-child(3), .list-row > :nth-child(4) { display:none; } }
  </style>
</head>
<body>
  <header class="topbar"><div class="brand"><span class="brand-mark"><i></i><i></i><i></i><i></i></span><span>Team Synergy</span></div><nav class="nav"><button data-screen="requirements">需求</button><button data-screen="design">设计</button><button data-screen="plan">计划</button><button class="active" data-screen="tasks">任务看板</button><button data-screen="defects">缺陷</button></nav><div class="account"><span>team-synergy</span><b class="avatar">L</b></div></header>
  <main class="app"><div class="page-head"><div><p class="eyebrow" id="eyebrow">PROJECT DELIVERY</p><h1 id="screen-title">任务看板</h1><p class="subtitle" id="screen-subtitle">查看任务状态、负责人和交付进度。</p></div><button class="primary" id="primary-action">新建任务</button></div><div id="screen-body"></div></main>
  <template id="screen-tasks"><section class="metrics"><div class="metric"><span>待处理</span><strong>12</strong></div><div class="metric"><span>执行中</span><strong>4</strong></div><div class="metric"><span>待验收</span><strong>3</strong></div><div class="metric"><span>本周完成</span><strong>18</strong></div></section><section class="board"><div class="column"><div class="column-head">待处理 <b class="count">3</b></div><article class="card"><span class="tag">账号体系</span><h3>首次登录时引导用户修改临时密码</h3><div class="card-foot"><span>Liam</span><span>08/21</span></div></article><article class="card"><span class="tag">团队管理</span><h3>成员权限配置弹窗</h3><div class="card-foot"><span>未分派</span><span>08/22</span></div></article></div><div class="column"><div class="column-head">已分派 <b class="count">2</b></div><article class="card"><span class="tag">设计工作台</span><h3>实现多视口交互原型预览</h3><div class="card-foot"><span>Chen</span><span>08/20</span></div></article></div><div class="column"><div class="column-head">执行中 <b class="count">1</b></div><article class="card"><span class="tag">任务上下文</span><h3>领取任务时同步视觉原型</h3><div class="card-foot"><span>Liam</span><span>今天</span></div></article></div><div class="column"><div class="column-head">已完成 <b class="count">18</b></div><article class="card"><span class="tag">需求管理</span><h3>结构化需求表与文档库</h3><div class="card-foot"><span>Wang</span><span>08/18</span></div></article></div></section></template>
  <template id="screen-requirements"><section class="surface"><div class="toolbar"><div class="search">搜索需求标题、模块或编码</div><button class="filter">全部模块</button><button class="filter">状态</button></div><div class="list-row header"><span>需求名称</span><span>模块</span><span>状态</span><span>负责人</span></div><div class="list-row"><strong>用户使用账号密码登录系统</strong><span>账号体系</span><span class="status">已确认</span><span>Liam</span></div><div class="list-row"><strong>项目成员可以浏览交互原型</strong><span>设计协作</span><span class="status">已确认</span><span>Chen</span></div><div class="list-row"><strong>任务领取后获得完整开发上下文</strong><span>Agent CLI</span><span class="status">实现中</span><span>Wang</span></div></section></template>
  <template id="screen-design"><section class="gallery"><article class="shot"><div class="shot-preview">Aa</div><div class="shot-info"><strong>全局导航与项目框架</strong><span>桌面端 · 5 个界面状态</span></div></article><article class="shot"><div class="shot-preview">▦</div><div class="shot-info"><strong>任务看板操作流程</strong><span>桌面 / 平板 · 8 个交互</span></div></article><article class="shot"><div class="shot-preview">↗</div><div class="shot-info"><strong>任务详情与交付</strong><span>桌面端 · 6 个界面状态</span></div></article></section></template>
  <template id="screen-plan"><section class="surface timeline"><div class="milestones"><div class="milestone"><strong>协作模型</strong><span>8月 01日</span></div><div class="milestone"><strong>需求与设计</strong><span>8月 20日</span></div><div class="milestone"><strong>任务交付</strong><span>9月 08日</span></div><div class="milestone"><strong>MVP 发布</strong><span>9月 30日</span></div></div></section></template>
  <template id="screen-defects"><section class="surface"><div class="toolbar"><div class="search">搜索缺陷标题或编码</div><button class="filter">全部严重度</button><button class="filter">待处理</button></div><div class="list-row header"><span>缺陷</span><span>严重度</span><span>状态</span><span>修复任务</span></div><div class="list-row"><strong>移动端筛选栏超出视口</strong><span>一般</span><span class="status">已确认</span><span>待创建</span></div><div class="list-row"><strong>原型预览切换后高度闪动</strong><span>较低</span><span class="status">修复中</span><span>关联任务</span></div></section></template>
  <script>
    const screens = {
      requirements: ['REQUIREMENTS', '需求', '集中查看需求文档与结构化需求点。', '新建需求'],
      design: ['PRODUCT DESIGN', '设计', '浏览产品界面、页面状态和交互流程。', '上传设计'],
      plan: ['PROJECT ROADMAP', '计划', '按阶段和里程碑安排产品交付节奏。', '新建里程碑'],
      tasks: ['PROJECT DELIVERY', '任务看板', '查看任务状态、负责人和交付进度。', '新建任务'],
      defects: ['QUALITY LOOP', '缺陷', '记录问题并跟踪对应的修复任务。', '提交缺陷']
    };
    function showScreen(name) {
      const meta = screens[name];
      document.getElementById('eyebrow').textContent = meta[0];
      document.getElementById('screen-title').textContent = meta[1];
      document.getElementById('screen-subtitle').textContent = meta[2];
      document.getElementById('primary-action').textContent = meta[3];
      const template = document.getElementById('screen-' + name);
      const body = document.getElementById('screen-body');
      body.replaceChildren(template.content.cloneNode(true));
      document.querySelectorAll('[data-screen]').forEach(button => button.classList.toggle('active', button.dataset.screen === name));
    }
    document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => showScreen(button.dataset.screen)));
    document.getElementById('primary-action').addEventListener('click', event => { event.currentTarget.textContent = '已打开创建面板'; });
    showScreen('tasks');
  </script>
</body>
</html>`;

export function prototypePreviewDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
  return `<!doctype html><html><head><meta charset="UTF-8">${policy}</head><body>${html}</body></html>`;
}

export function DesignWorkbench({ projectCode }: { projectCode: string }) {
  useLocale();
  const queryClient = useQueryClient();
  const { canWrite } = useProjectAccess(projectCode);
  const { projectName, memberName } = useProjectDisplayNames();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [previewSize, setPreviewSize] = useState<PreviewSize>('fit');
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(800);
  const [viewMode, setViewMode] = useState<'preview' | 'notes'>('preview');
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const prototypesQuery = useQuery({
    queryKey: ['design-prototypes', projectCode],
    queryFn: () => listDesignPrototypes(projectCode),
  });
  const requirementsQuery = useQuery({
    queryKey: ['requirements', projectCode],
    queryFn: () => listRequirements(projectCode),
  });
  const prototypes = prototypesQuery.data ?? [];
  const selected = prototypes.find((item) => item.code === selectedCode) ?? prototypes[0];
  const detailQuery = useQuery({
    queryKey: ['design-prototype', selected?.code],
    queryFn: () => getDesignPrototype(selected!.code),
    enabled: Boolean(selected),
  });
  useEffect(() => {
    if (!selectedCode && prototypes[0]) setSelectedCode(prototypes[0].code);
  }, [prototypes, selectedCode]);

  const visiblePrototypes = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return prototypes;
    return prototypes.filter((prototype) => [prototype.title, prototype.summary, ...prototype.linked_requirements.map((item) => item.title)].join(' ').toLocaleLowerCase().includes(keyword));
  }, [prototypes, search]);
  const createMutation = useMutation({
    mutationFn: (input: DesignPrototypeInput) => createDesignPrototype(projectCode, input),
    onSuccess: (prototype) => {
      queryClient.setQueryData(['design-prototype', prototype.code], prototype);
      void queryClient.invalidateQueries({ queryKey: ['design-prototypes', projectCode] });
      setSelectedCode(prototype.code);
      setDialog(null);
    },
  });
  const reviseMutation = useMutation({
    mutationFn: ({ code, input }: { code: string; input: DesignPrototypeInput }) => reviseDesignPrototype(code, input),
    onSuccess: (prototype) => {
      queryClient.setQueryData(['design-prototype', prototype.code], prototype);
      void queryClient.invalidateQueries({ queryKey: ['design-prototypes', projectCode] });
      setDialog(null);
    },
  });

  if (prototypesQuery.isLoading || requirementsQuery.isLoading) return <WorkbenchLoading label={t("正在加载设计原型…")} />;
  if (prototypesQuery.error || requirementsQuery.error) return <WorkbenchError error={prototypesQuery.error ?? requirementsQuery.error} />;
  const detail = detailQuery.data ? { ...detailQuery.data, can_edit: canWrite && detailQuery.data.can_edit } : undefined;
  const linkedRequirementCount = new Set(prototypes.flatMap((prototype) => prototype.linked_requirements.map((item) => item.requirement_code))).size;
  const preset = PREVIEW_SIZE_PRESETS.find((item) => item.value === previewSize);
  const frameWidth = previewSize === 'custom' ? customWidth : preset?.width;
  const frameHeight = previewSize === 'custom' ? customHeight : preset?.height ?? 620;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-100/70 p-4 lg:p-5">
      <section className="mx-auto flex min-h-[calc(100vh-86px)] max-w-[1720px] flex-col">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold tracking-[0.18em] text-cyan-700">PRODUCT DESIGN</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{t("{0} · 设计", { "0": projectName || t('项目') })}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("集中管理 HTML、图片、URL 链接和特殊文件，关联需求并保留配套说明。")}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden h-9 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-500 shadow-sm sm:flex"><span>{t("{0} 份资料", { "0": prototypes.length })}</span><i className="h-3 w-px bg-slate-200" /><span>{t("{0} 个关联需求", { "0": linkedRequirementCount })}</span></div>
            {canWrite && <button type="button" onClick={() => setDialog('create')} className="ui-button ui-button-primary">{t("添加设计资料")}</button>}
          </div>
        </header>

        {prototypes.length === 0 ? (
          <EmptyDesignState canWrite={canWrite} onCreate={() => setDialog('create')} />
        ) : (
          <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[270px_minmax(560px,1fr)_290px]">
            <aside className="flex min-h-[720px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={t("设计方案")}>
              <div className="border-b border-slate-100 p-3.5"><div className="flex items-center justify-between"><div><h2 className="text-sm font-bold text-slate-900">{t("设计方案")}</h2><p className="mt-0.5 text-[11px] text-slate-500">{t("HTML、图片、链接与文件")}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-500">{visiblePrototypes.length}</span></div><input aria-label={t("搜索设计方案")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索方案、界面或需求")} className="mt-3 h-8 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 outline-none placeholder:font-normal placeholder:text-slate-500 focus:border-cyan-400 focus:bg-white" /></div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
                {visiblePrototypes.map((prototype) => {
                  const meta = STATUS_META[prototype.status];
                  return <button key={prototype.code} type="button" onClick={() => { setSelectedCode(prototype.code); setViewMode('preview'); }} className={`w-full rounded-xl border p-3 text-left transition ${selected?.code === prototype.code ? 'border-cyan-300 bg-cyan-50/70 shadow-sm' : 'border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${meta.className}`}>{t(meta.label)}</span><span className="text-[11px] text-slate-500">r{prototype.current_revision}</span></div><h3 className="mt-2 text-sm font-bold leading-5 text-slate-800">{prototype.title}</h3><p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500">{prototype.summary || t("暂无设计范围")}</p><div className="mt-2 flex items-center justify-between text-[11px] text-slate-500"><span>{t("{0} 个需求", { "0": prototype.linked_requirements.length })}</span><time>{prototype.updated_at ? new Date(prototype.updated_at).toLocaleDateString(getLocale()) : '—'}</time></div></button>;
                })}
                {visiblePrototypes.length === 0 && <div className="grid min-h-40 place-items-center text-xs text-slate-500">{t("没有匹配的设计资料")}</div>}
              </div>
            </aside>

            <section className="flex min-h-[720px] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={t("视觉与交互预览")}>
              <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div className="min-w-0"><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-emerald-500" /><span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{viewMode === 'preview' ? 'Interactive preview' : 'Implementation notes'}</span></div><h2 className="mt-1 truncate text-sm font-bold text-slate-900">{detail?.title ?? selected?.title}</h2></div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="ui-segmented" role="group" aria-label={t("设计内容")}><ViewportButton active={viewMode === 'preview'} label={t("设计资料")} onClick={() => setViewMode('preview')} /><ViewportButton active={viewMode === 'notes'} label={t("配套说明")} onClick={() => setViewMode('notes')} /></div>
                  {viewMode === 'preview' && detail && designContentKind(detail) !== 'file' && <PreviewSizeControl value={previewSize} customWidth={customWidth} customHeight={customHeight} onChange={setPreviewSize} onWidthChange={setCustomWidth} onHeightChange={setCustomHeight} />}
                </div>
              </div>
              <div className={`min-h-0 flex-1 overflow-auto p-4 ${viewMode === 'preview' ? 'bg-[radial-gradient(#cbd5e1_0.7px,transparent_0.7px)] bg-[size:18px_18px]' : 'bg-slate-50'}`}>
                {detailQuery.isLoading ? <div className="grid h-full place-items-center text-sm text-slate-500">{t("正在加载设计资料…")}</div> : detailQuery.error ? <WorkbenchError error={detailQuery.error} /> : detail ? viewMode === 'preview' ? <DesignContentPreview key={`${detail.code}-${detail.current_revision}`} detail={detail} width={frameWidth} height={frameHeight} /> : <DesignNotesPanel detail={detail} pending={reviseMutation.isPending} onSave={(notes) => reviseMutation.mutate({ code: detail.code, input: designNotesRevision(detail, notes) })} /> : null}
                {viewMode === 'notes' && reviseMutation.error && <p role="alert" className="mt-3 text-sm text-rose-700">{t("保存失败：{0}", { "0": reviseMutation.error.message })}</p>}
              </div>
            </section>

            <aside className="flex min-h-[720px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={t("原型详情")}>
              {detail ? <><div className="border-b border-slate-100 p-4"><div className="flex items-center justify-between gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${STATUS_META[detail.status].className}`}>{t(STATUS_META[detail.status].label)}</span><code className="text-[11px] text-slate-500">{detail.code}</code></div><h2 className="mt-3 text-lg font-bold leading-6 text-slate-900">{detail.title}</h2><p className="mt-2 text-xs leading-5 text-slate-500">{detail.summary || t("暂无设计范围")}</p>{detail.can_edit && (canWrite && <button type="button" onClick={() => setDialog('edit')} className="ui-button ui-button-secondary ui-button-block mt-4">{t("编辑并创建新版本")}</button>)}</div><div className="min-h-0 flex-1 overflow-y-auto"><DetailSection title={t("关联需求")} count={detail.linked_requirements.length}>{detail.linked_requirements.length ? <div className="space-y-2">{detail.linked_requirements.map((requirement) => <a key={requirement.requirement_code} href={requirementWorkspacePath(projectCode, { tab: 'checklist' })} title={t("需求编码：{0}", { "0": requirement.requirement_code })} className="block rounded-xl border border-slate-100 bg-slate-50 p-3 hover:border-cyan-200 hover:bg-cyan-50/40"><div className="text-xs font-bold leading-5 text-slate-700">{requirement.title}</div><div className="mt-1 truncate text-[11px] text-slate-500">{requirement.feature_name || t("未绑定 Feature")}</div></a>)}</div> : <EmptyDetail label={t("尚未关联结构化需求点")} />}</DetailSection><DetailSection title={t("版本记录")} count={detail.revisions.length}><div className="space-y-3">{detail.revisions.map((revision, index) => <div key={revision.code} className="relative pl-5"><span className={`absolute left-0 top-1.5 h-2 w-2 rounded-full ${index === 0 ? 'bg-cyan-500 ring-4 ring-cyan-50' : 'bg-slate-300'}`} />{index < detail.revisions.length - 1 && <span className="absolute bottom-[-14px] left-[3px] top-4 w-px bg-slate-200" />}<div className="flex items-center justify-between"><strong className="text-xs text-slate-700">Revision {revision.revision}</strong><time className="text-[11px] text-slate-500">{new Date(revision.created_at).toLocaleDateString(getLocale())}</time></div><p className="mt-1 text-[11px] leading-4 text-slate-500">{revision.change_summary}</p><div className="mt-1 flex items-center gap-2"><span className="text-[11px] text-slate-500">{memberName(revision.created_by)}</span>{revision.has_notes && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-500">{t("含配套说明")}</span>}</div>{revision.content_kind === 'file' && <div className="mt-2 space-y-1"><p className="break-all text-[11px] text-slate-500">{revision.file_name} · {formatFileSize(revision.file_size)}</p><DesignFileDownload prototypeCode={detail.code} revision={revision.revision} fileName={revision.file_name || detail.title} /></div>}{revision.content_kind === 'url' && designExternalUrl(revision.external_url ?? '') && <a href={designExternalUrl(revision.external_url ?? '') ?? undefined} target="_blank" rel="noopener noreferrer" className="mt-2 block text-[11px] text-cyan-700 underline">{t("打开此版本链接")}</a>}</div>)}</div></DetailSection></div></> : null}
            </aside>
          </div>
        )}
      </section>

      {canWrite && dialog && <PrototypeEditorDialog key={`${dialog}-${detail?.code ?? 'new'}`} mode={dialog} initial={dialog === 'edit' ? detail : undefined} requirements={requirementsQuery.data ?? []} pending={createMutation.isPending || reviseMutation.isPending} error={(createMutation.error ?? reviseMutation.error) as Error | null} onClose={() => { createMutation.reset(); reviseMutation.reset(); setDialog(null); }} onSubmit={(input) => dialog === 'create' ? createMutation.mutate(input) : detail && reviseMutation.mutate({ code: detail.code, input })} />}
    </main>
  );
}

export function DesignContentPreview({ detail, width, height }: { detail: DesignPrototypeDetail; width?: number | null; height: number }) {
  useLocale();
  const kind = designContentKind(detail);
  const [previewUrl, setPreviewUrl] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const url = designExternalUrl(detail.external_url ?? '');
  if (kind === 'file') return (
    <div className="mx-auto grid min-h-[480px] max-w-2xl place-items-center rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <div className="min-w-0"><span className="text-4xl text-cyan-700">▤</span><h3 className="mt-4 break-all text-lg font-bold text-slate-900">{detail.file_name || detail.title}</h3><p className="mt-2 text-sm text-slate-500">{formatFileSize(detail.file_size)}</p><p className="mt-2 break-all text-xs text-slate-500">{detail.file_mime_type || 'application/octet-stream'}</p><p className="mb-5 mt-5 text-sm text-slate-500">{t("文件已保存，可下载后使用对应软件打开。")}</p><DesignFileDownload prototypeCode={detail.code} revision={detail.current_revision} fileName={detail.file_name || detail.title} /></div>
    </div>
  );
  if (kind === 'url' && !url) return <div role="alert" className="rounded-xl bg-white p-6 text-sm text-rose-700">{t("链接无效，仅支持不含登录凭据的 HTTP 或 HTTPS 地址。")}</div>;
  return (
    <div className="mx-auto flex-none overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10 transition-[width,height]" style={{ width: width == null ? '100%' : `${width}px` }}>
      {kind === 'url' && <div className="border-b border-slate-200 p-5"><p className="break-all text-sm text-slate-600">{url}</p><div className="mt-4 flex flex-wrap gap-2"><a href={url ?? undefined} target="_blank" rel="noopener noreferrer" className="ui-button ui-button-primary">{t("在原站打开")}</a><button type="button" className="ui-button ui-button-secondary" onClick={() => { setPreviewError(false); setPreviewUrl(!previewUrl); }}>{previewUrl ? t("收起网页预览") : t("尝试网页预览")}</button></div><p className="mt-3 text-xs leading-5 text-slate-500">{t("网页内容由原站提供，可能需要登录，也可能不允许嵌入。若无法预览，请在原站打开。")}</p>{previewError && <p role="alert" className="mt-2 text-xs text-rose-700">{t("网页预览加载失败，请在原站打开。")}</p>}</div>}
      {kind === 'url' ? previewUrl && <iframe title={t("{0} 网页预览", { "0": detail.title })} src={url ?? undefined} sandbox="allow-scripts" referrerPolicy="no-referrer" onError={() => setPreviewError(true)} style={{ height }} className="w-full border-0 bg-white" /> : <iframe title={t("{0} 视觉与交互原型", { "0": detail.title })} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={prototypePreviewDocument(detail.html_content)} style={{ height }} className="w-full border-0 bg-white" />}
    </div>
  );
}

function DesignFileDownload({ prototypeCode, revision, fileName }: { prototypeCode: string; revision: number; fileName: string }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setDownloading(true);
    setError('');
    try {
      const blob = await getDesignPrototypeFile(prototypeCode, revision);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = Array.from(fileName, (character) => character < ' ' || character === '\u007f' || character === '/' || character === '\\' ? '_' : character).join('');
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("文件下载失败"));
    } finally {
      setDownloading(false);
    }
  }
  return <div><button type="button" disabled={downloading} className="ui-button ui-button-secondary" onClick={() => void download()}>{downloading ? t("下载中…") : t("下载文件")}</button>{error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}</div>;
}

function ViewportButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className="ui-segmented-item">{label}</button>;
}

function PreviewSizeControl({ value, customWidth, customHeight, onChange, onWidthChange, onHeightChange }: {
  value: PreviewSize;
  customWidth: number;
  customHeight: number;
  onChange: (value: PreviewSize) => void;
  onWidthChange: (value: number) => void;
  onHeightChange: (value: number) => void;
}) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  return <div className="flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-1 shadow-sm" aria-label={t("预览尺寸")}>
    <select aria-label={t("预览宽高")} value={value} onChange={(event) => onChange(event.target.value as PreviewSize)} className="h-6 rounded-md bg-transparent px-1.5 text-[12px] font-medium text-slate-600 outline-none">
      {PREVIEW_SIZE_PRESETS.map((item) => <option key={item.value} value={item.value}>{t(item.label)}</option>)}
      <option value="custom">{t("自定义尺寸")}</option>
    </select>
    {value === 'custom' && <div className="flex items-center gap-1 border-l border-slate-200 pl-1 text-[11px] text-slate-500">
      <input aria-label={t("自定义预览宽度")} type="number" min={320} max={2560} value={customWidth} onChange={(event) => onWidthChange(clamp(event.target.valueAsNumber, 320, 2560))} className="h-6 w-14 rounded bg-slate-50 px-1 text-center text-xs font-medium leading-4 text-slate-600 outline-none focus:ring-1 focus:ring-cyan-400" />
      <span>×</span>
      <input aria-label={t("自定义预览高度")} type="number" min={480} max={1800} value={customHeight} onChange={(event) => onHeightChange(clamp(event.target.valueAsNumber, 480, 1800))} className="h-6 w-14 rounded bg-slate-50 px-1 text-center text-xs font-medium leading-4 text-slate-600 outline-none focus:ring-1 focus:ring-cyan-400" />
    </div>}
  </div>;
}

function DetailSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section className="border-b border-slate-100 p-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-bold text-slate-800">{title}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{count}</span></div>{children}</section>;
}

function EmptyDetail({ label }: { label: string }) {
  return <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-[11px] text-slate-500">{label}</div>;
}

function DesignNotesPanel({ detail, pending, onSave }: {
  detail: DesignPrototypeDetail;
  pending: boolean;
  onSave: (notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(detail.notes_markdown || t(DEFAULT_DESIGN_NOTES));

  useEffect(() => {
    setNotes(detail.notes_markdown || t(DEFAULT_DESIGN_NOTES));
    setEditing(false);
  }, [detail.code, detail.current_revision, detail.notes_markdown]);

  return (
    <article className="mx-auto min-h-[620px] max-w-4xl rounded-xl border border-slate-200 bg-white px-8 py-7 shadow-sm">
      <header className="mb-6 flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-700">Companion design notes</p>
          <h3 className="mt-1 text-lg font-bold text-slate-900">{t("配套设计说明")}</h3>
          <p className="mt-1 text-xs text-slate-500">{t("与当前原型 Revision 同版本保存，并随开发任务一起下发。")}</p>
        </div>
        {detail.can_edit && Boolean(detail.notes_markdown) && !editing && <button type="button" onClick={() => setEditing(true)} className="ui-button ui-button-secondary">{t("编辑说明")}</button>}
      </header>
      {editing && detail.can_edit ? (
        <div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-inner">
            <div className="flex h-9 items-center justify-between border-b border-slate-200 bg-slate-50 px-3 text-[11px] text-slate-500"><span className="font-medium">Markdown</span><span>{t("{0} 字符", { "0": notes.length.toLocaleString(getLocale()) })}</span></div>
            <textarea aria-label={t("配套设计说明")} value={notes} onChange={(event) => setNotes(event.target.value)} spellCheck={false} className="min-h-[470px] w-full resize-y bg-white p-4 font-sans text-sm leading-6 text-slate-700 outline-none placeholder:text-slate-500 focus:bg-cyan-50/20" />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => { setNotes(detail.notes_markdown || t(DEFAULT_DESIGN_NOTES)); setEditing(false); }} className="ui-button ui-button-secondary">{t("取消")}</button>
            <button type="button" disabled={pending} onClick={() => onSave(notes)} className="ui-button ui-button-primary">{pending ? t("保存中…") : t("保存为新版本")}</button>
          </div>
        </div>
      ) : detail.notes_markdown ? (
        <MarkdownDocument content={detail.notes_markdown} />
      ) : (
        <div className="grid min-h-[470px] place-items-center text-center"><div><strong className="text-sm text-slate-700">{t("当前版本尚无配套说明")}</strong><p className="mt-2 text-xs text-slate-500">{t("可以补充业务、数据、代码逻辑和注意事项。")}</p>{detail.can_edit && <button type="button" onClick={() => setEditing(true)} className="ui-button ui-button-primary mt-4">{t("编写说明")}</button>}</div></div>
      )}
    </article>
  );
}

function EmptyDesignState({ canWrite, onCreate }: { canWrite: boolean; onCreate: () => void }) {
  return <div className="grid flex-1 place-items-center rounded-3xl border border-dashed border-cyan-200 bg-white p-10 text-center shadow-sm"><div className="max-w-xl"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-slate-950 text-2xl text-cyan-300">⌘</div><p className="mt-6 text-[11px] font-bold tracking-[0.18em] text-cyan-700">VISUAL & INTERACTION DESIGN</p><h2 className="mt-2 text-3xl font-bold text-slate-950">{t("添加第一份设计资料")}</h2><p className="mt-3 text-sm leading-7 text-slate-500">{t("支持 HTML 文件展示、图片展示、URL 链接和特殊文件存储，可关联需求并保留版本与配套说明。")}</p>{canWrite && <button type="button" onClick={onCreate} className="ui-button ui-button-primary mt-6">{t("添加设计资料")}</button>}</div></div>;
}

export function PrototypeEditorDialog({ mode, initial, requirements, pending, error, onClose, onSubmit }: {
  mode: 'create' | 'edit';
  initial?: DesignPrototypeDetail;
  requirements: Requirement[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: DesignPrototypeInput) => void;
}) {
  useLocale();
  const initialImage = imagePrototypeFromHtml(initial?.html_content ?? '');
  const [title, setTitle] = useState(initial?.title ?? t("产品界面与交互方案"));
  const [summary, setSummary] = useState(initial?.summary ?? t("展示核心页面、界面状态和用户操作反馈。"));
  const [html, setHtml] = useState(initial?.html_content ?? DEFAULT_VISUAL_PROTOTYPE_HTML);
  const [mediaKind, setMediaKind] = useState<DesignPrototypeKind>(initial ? designContentKind(initial) : 'html');
  const [imageDataUrl, setImageDataUrl] = useState(initialImage?.dataUrl ?? '');
  const [imageAlt, setImageAlt] = useState(initialImage?.alt ?? initial?.title ?? t("设计原型图片"));
  const [notes] = useState(initial?.notes_markdown ?? t(DEFAULT_DESIGN_NOTES));
  const [status, setStatus] = useState<DesignPrototypeStatus>(initial?.status ?? 'draft');
  const [requirementCodes, setRequirementCodes] = useState<string[]>(initial?.linked_requirements.map((item) => item.requirement_code) ?? []);
  const [changeSummary, setChangeSummary] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [externalUrl, setExternalUrl] = useState(initial?.external_url ?? '');
  const [uploadedFile, setUploadedFile] = useState<{ name: string; mimeType: string; size: number; base64: string } | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const fileReadVersion = useRef(0);
  const existingFile = initial && designContentKind(initial) === 'file' ? initial : null;
  const validUrl = designExternalUrl(externalUrl);
  const hasContent = mediaKind === 'html' ? Boolean(html.trim()) : mediaKind === 'image' ? Boolean(imageDataUrl) : mediaKind === 'url' ? Boolean(validUrl) : Boolean(uploadedFile || existingFile);

  function selectKind(kind: DesignPrototypeKind) {
    fileReadVersion.current += 1;
    setReadingFile(false);
    setMediaKind(kind);
    setFileName('');
    setFileError('');
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setFileError('');
    const readVersion = ++fileReadVersion.current;
    const validationError = designUploadError(mediaKind, file);
    if (validationError) {
      setReadingFile(false);
      setFileError(validationError);
      return;
    }
    setReadingFile(true);
    try {
      if (mediaKind === 'html') {
        const text = await file.text();
        if (readVersion !== fileReadVersion.current) return;
        setHtml(text);
      } else {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(t("文件读取失败")));
          reader.onerror = () => reject(reader.error ?? new Error(t("文件读取失败")));
          reader.onabort = () => reject(new Error(t("文件读取已取消")));
          reader.readAsDataURL(file);
        });
        if (readVersion !== fileReadVersion.current) return;
        if (mediaKind === 'image') {
          setImageDataUrl(dataUrl);
          setImageAlt(file.name.replace(/\.(?:png|jpe?g|webp|gif)$/i, ''));
        } else {
          setUploadedFile({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
        }
      }
      setFileName(file.name);
      if (!title.trim() || title === t("产品界面与交互方案")) setTitle(file.name.replace(/\.(?:html?|png|jpe?g|webp|gif)$/i, ''));
    } catch (cause) {
      if (readVersion === fileReadVersion.current) setFileError(cause instanceof Error ? cause.message : t("文件读取失败，请重新选择"));
    } finally {
      if (readVersion === fileReadVersion.current) setReadingFile(false);
    }
  }
  function toggleRequirement(code: string) {
    setRequirementCodes((items) => items.includes(code) ? items.filter((item) => item !== code) : [...items, code]);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (readingFile || !hasContent || pending || fileError) return;
    const htmlContent = mediaKind === 'image' ? createImagePrototypeHtml(imageDataUrl, imageAlt || title) : mediaKind === 'html' ? html : '';
    onSubmit({ title, summary, content_kind: mediaKind, html_content: htmlContent,
      ...(mediaKind === 'url' ? { external_url: validUrl ?? undefined } : {}),
      ...(mediaKind === 'file' ? {
        file_name: uploadedFile?.name ?? existingFile?.file_name ?? undefined,
        file_mime_type: uploadedFile?.mimeType ?? existingFile?.file_mime_type ?? undefined,
        file_content_base64: uploadedFile?.base64,
      } : {}),
      notes_markdown: notes, requirement_codes: requirementCodes, status, change_summary: mode === 'edit' ? changeSummary : undefined });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-3 sm:p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="prototype-dialog-title" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl sm:max-h-[92dvh]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
          <div>
            <p className="text-[11px] font-bold tracking-[0.18em] text-cyan-700">VISUAL PROTOTYPE · {mode === 'create' ? 'NEW' : `REVISION ${initial ? initial.current_revision + 1 : ''}`}</p>
            <h2 id="prototype-dialog-title" className="mt-1 text-xl font-semibold leading-7 text-slate-950">{mode === 'create' ? t("添加设计资料") : t("编辑并创建新版本")}</h2>
            <p className="ui-help mt-1">{t("支持 HTML、图片、URL 链接和特殊文件；资料内容和配套说明按版本保存，可关联需求。")}</p>
          </div>
          <button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("关闭")}</button>
        </header>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="modal-scroll-region min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
              <div className="space-y-4">
                <Field label={t("设计方案名称")}><input required autoFocus value={title} onChange={(event) => setTitle(event.target.value)} className="form-control" /></Field>
                <Field label={t("设计范围")}><textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={t("例如：项目工作台桌面端，覆盖导航、任务看板和任务详情")} className="form-control resize-y leading-6" /></Field>
                <Field label={t("状态")}><select value={status} onChange={(event) => setStatus(event.target.value as DesignPrototypeStatus)} className="form-control bg-white"><option value="draft">{t("草稿")}</option><option value="ready">{t("可供开发")}</option>{mode === 'edit' && <option value="archived">{t("归档")}</option>}</select></Field>
                {mode === 'edit' && <Field label={t("本次变更说明")}><input required value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} placeholder={t("例如：更新文件、链接或设计内容")} className="form-control" /></Field>}
                <section>
                  <div className="flex items-center justify-between"><h3 className="ui-field-label">{t("关联需求")}</h3><span className="ui-meta">{t("已选 {0}", { "0": requirementCodes.length })}</span></div>
                  <p className="ui-help mt-1">{t("用于开发任务查找本设计，不会展示在原型画面内。")}</p>
                  <div className="scroll-region mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2 lg:max-h-64">
                    {requirements.map((requirement) => (
                      <label key={requirement.code} className={`flex cursor-pointer items-start gap-2 rounded-lg p-2.5 transition ${requirementCodes.includes(requirement.code) ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}>
                        <input type="checkbox" checked={requirementCodes.includes(requirement.code)} onChange={() => toggleRequirement(requirement.code)} className="mt-0.5 accent-cyan-700" />
                        <span className="min-w-0"><strong className="block text-xs font-semibold leading-5 text-slate-700">{requirement.title}</strong><span className="ui-meta block truncate">{requirement.code}</span></span>
                      </label>
                    ))}
                    {requirements.length === 0 && <div className="p-4 text-center text-xs text-slate-500">{t("项目尚无结构化需求点")}</div>}
                  </div>
                </section>
              </div>

              <div className="flex min-w-0 flex-col">
                <div className="ui-segmented mb-4 w-fit" role="group" aria-label={t("设计资料类型")}>
                  <ViewportButton active={mediaKind === 'html'} label={t("交互 HTML")} onClick={() => selectKind('html')} />
                  <ViewportButton active={mediaKind === 'image'} label={t("界面图片")} onClick={() => selectKind('image')} />
                  <ViewportButton active={mediaKind === 'url'} label={t("URL 链接")} onClick={() => selectKind('url')} />
                  <ViewportButton active={mediaKind === 'file'} label={t("特殊文件")} onClick={() => selectKind('file')} />
                </div>
                {mediaKind !== 'url' && <label className="flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-cyan-300 bg-cyan-50/60 px-4 py-3 text-xs leading-5 text-cyan-800 hover:bg-cyan-50 focus-within:ring-2 focus-within:ring-cyan-500">
                  <span className="min-w-0 flex-1 basis-48"><strong className="block font-semibold">{mediaKind === 'html' ? t("上传可运行的视觉原型") : mediaKind === 'image' ? t("上传界面原型图片") : t("上传特殊文件")}</strong><span className="mt-1 block text-xs leading-5 text-cyan-800">{mediaKind === 'html' ? t("HTML 可包含样式和交互脚本，最大 6 MiB") : mediaKind === 'image' ? t("支持 PNG、JPEG、WebP、GIF，最大 4 MiB") : t("支持任意格式，最大 20 MiB；保存后可下载")}</span></span>
                  <span className="ui-button ui-button-secondary max-w-48 shrink-0"><span className="truncate">{readingFile ? t("读取中…") : fileName || t("选择文件")}</span></span>
                  <input key={mediaKind} type="file" accept={mediaKind === 'html' ? '.html,.htm,text/html' : mediaKind === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : undefined} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void loadFile(file); }} />
                </label>}
                {fileError && <div role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{fileError}</div>}
                {mediaKind === 'html' ? (
                  <label className="ui-field-label mt-4 flex min-h-0 flex-1 flex-col">{t("视觉原型源码")}<textarea required value={html} onChange={(event) => { setHtml(event.target.value); setFileError(''); }} spellCheck={false} className="mt-2 min-h-80 flex-1 resize-y rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs font-normal leading-5 text-cyan-100 outline-none focus:ring-2 focus:ring-cyan-300 lg:min-h-[540px]" /></label>
                ) : mediaKind === 'image' ? (
                  <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
                    <Field label={t("图片说明")}><input required value={imageAlt} onChange={(event) => setImageAlt(event.target.value)} placeholder={t("描述这张界面图，便于检索和无障碍阅读")} className="form-control" /></Field>
                    <div className="grid min-h-64 flex-1 place-items-center overflow-auto rounded-xl border border-slate-200 bg-[radial-gradient(#cbd5e1_0.7px,transparent_0.7px)] bg-[size:18px_18px] p-5 lg:min-h-[500px]">
                      {imageDataUrl ? <img src={imageDataUrl} alt={imageAlt || t("原型预览")} className="max-h-[620px] max-w-full rounded-lg bg-white object-contain shadow-xl shadow-slate-900/10" /> : <div className="max-w-sm text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-cyan-50 text-xl text-cyan-700">▧</div><strong className="mt-4 block text-sm text-slate-700">{t("选择一张界面图片")}</strong><p className="mt-2 text-xs leading-5 text-slate-500">{t("图片会作为独立 Revision 保存，并可在画布中按不同宽高预览。")}</p></div>}
                    </div>
                  </div>
                ) : mediaKind === 'url' ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-5"><Field label={t("网页 URL")}><input type="url" required value={externalUrl} onChange={(event) => setExternalUrl(event.target.value)} placeholder="https://example.com/design" className="form-control" /></Field><p className="mt-3 text-xs leading-6 text-slate-500">{t("保存完整 HTTP 或 HTTPS 链接。可在原站打开，或在详情中尝试网页预览；内容和访问权限由原站管理。")}</p>{externalUrl.trim() && !validUrl && <p role="alert" className="mt-2 text-xs text-rose-700">{t("请输入不含登录凭据的 HTTP 或 HTTPS 链接。")}</p>}</div>
                ) : (
                  <div className="mt-3 grid min-h-64 lg:min-h-[440px] place-items-center rounded-xl border border-slate-200 bg-slate-50 p-6 text-center"><div><div className="text-4xl text-cyan-700">▤</div><strong className="mt-4 block break-all text-sm text-slate-800">{uploadedFile?.name || existingFile?.file_name || t("选择需要保存的文件")}</strong><p className="mt-2 text-xs text-slate-500">{uploadedFile || existingFile ? formatFileSize(uploadedFile?.size ?? existingFile?.file_size) : t("如设计源文件、文档或压缩包，最大 20 MiB")}</p><p className="mt-3 text-xs leading-6 text-slate-500">{t("保存后可以下载，使用对应的软件打开。")}{existingFile && !uploadedFile ? t("未选择新文件时，保留当前文件。") : ''}</p></div></div>
                )}
              </div>
            </div>
            {error && <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">{t("保存失败：{0}", { "0": error.message })}</div>}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-6">
            <span className="ui-help min-w-0 flex-1 basis-64">{t("资料内容和配套说明按版本保存，可关联需求。")}</span>
            <div className="ml-auto flex shrink-0 gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button type="submit" disabled={pending || readingFile || Boolean(fileError) || !title.trim() || !hasContent || (mode === 'edit' && !changeSummary.trim())} className="ui-button ui-button-primary">{pending ? t("保存中…") : mode === 'create' ? t("保存设计资料") : t("保存为新版本")}</button></div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="ui-field-label">{label}<div className="mt-2">{children}</div></label>;
}

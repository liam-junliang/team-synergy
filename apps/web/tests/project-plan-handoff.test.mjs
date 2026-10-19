import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

test('导航命名：文档库与跨人交接具有独立入口', async () => {
  const { PROJECT_VIEWS } = await vite.ssrLoadModule('/src/App.tsx');
  const labels = Object.fromEntries(PROJECT_VIEWS.map((item) => [item.id, item.label]));

  assert.deepEqual(PROJECT_VIEWS.map((item) => item.id), ['overview', 'documents', 'plan', 'requirements', 'design', 'board', 'testing', 'defects', 'handovers']);
  assert.equal(labels.overview, '项目');
  assert.equal(labels.baselines, undefined);
  assert.ok(PROJECT_VIEWS.every((item) => item.label !== '项目理解'));
  assert.equal(labels.design, '设计');
  assert.equal(labels.plan, '计划');
  assert.equal(labels.board, '任务');
  assert.equal(labels.documents, '文档');
  assert.equal(labels.handovers, '交接');
  assert.equal(labels.testing, '测试');
  assert.equal(labels.orchestration, undefined);
  assert.equal(labels.acceptance, undefined);
});

test('时间轴推导：优先读取 canonical date 字段并在空日期时回退到当前季度', async () => {
  const { deriveTimelineRange } = await vite.ssrLoadModule('/src/projectPlanTimeline.ts');

  const scheduled = deriveTimelineRange(
    [{ code: 'PHASE-1', project_code: 'PROJECT-A', name: '阶段', summary: null, status: 'planned', order: 1, start_at: '2026-08-10', end_at: '2026-09-20' }],
    [{ code: 'MILESTONE-1', project_code: 'PROJECT-A', phase_code: 'PHASE-1', phase_name: '阶段', name: '里程碑', summary: null, status: 'planned', order: 1, start_at: '2026-08-17', target_at: '2026-09-03' }],
    new Date('2026-08-17T00:00:00Z'),
  );

  assert.equal(scheduled.startKey, '2026-08-03');
  assert.equal(scheduled.endKey, '2026-09-27');
  assert.ok(scheduled.monthBands.length >= 2);

  const fallback = deriveTimelineRange([], [], new Date('2026-08-17T00:00:00Z'));
  assert.equal(fallback.startKey, '2026-06-24');
  assert.equal(fallback.endKey, '2026-10-07');
});

test('开源甘特数据：阶段、里程碑与 Feature 形成同一棵树，未排期项保持未排期', async () => {
  const { buildPlanGanttTasks, decodeGanttDomTaskId, parseGanttTaskId } = await vite.ssrLoadModule('/src/projectPlanGantt.ts');
  const phases = [
    { code: 'PHASE-1', project_code: 'PROJECT-A', name: 'MVP', summary: null, status: 'active', order: 1, start_at: '2026-08-10', end_at: '2026-09-15' },
    { code: 'PHASE-2', project_code: 'PROJECT-A', name: '后续', summary: null, status: 'planned', order: 2, start_at: null, end_at: null },
  ];
  const milestones = [
    { code: 'MILESTONE-1', project_code: 'PROJECT-A', phase_code: 'PHASE-1', phase_name: 'MVP', name: '首个里程碑', summary: null, status: 'active', order: 1, start_at: '2026-08-17', target_at: '2026-08-31' },
    { code: 'MILESTONE-2', project_code: 'PROJECT-A', phase_code: 'PHASE-2', phase_name: '后续', name: '待排期里程碑', summary: null, status: 'planned', order: 1, start_at: null, target_at: null },
  ];
  const features = [
    { code: 'FEATURE-1', project_code: 'PROJECT-A', title: '甘特重构', goal: '更清晰', status: 'active', milestone_code: 'MILESTONE-1', milestone_name: '首个里程碑', start_at: '2026-08-19', end_at: '2026-08-24' },
  ];

  const tasks = buildPlanGanttTasks(phases, milestones, features);
  assert.deepEqual(tasks.map((item) => item.id), [
    'phase:PHASE-1',
    'milestone:MILESTONE-1',
    'feature:FEATURE-1',
    'phase:PHASE-2',
    'milestone:MILESTONE-2',
  ]);
  assert.equal(tasks[1].parent, 'phase:PHASE-1');
  assert.equal(tasks[2].parent, 'milestone:MILESTONE-1');
  assert.equal(tasks[2].scheduleLabel, '8/19 - 8/24');
  assert.equal(tasks[4].unscheduled, true);
  assert.deepEqual(parseGanttTaskId(tasks[2].id), { kind: 'feature', code: 'FEATURE-1' });
  assert.equal(decodeGanttDomTaskId(':phase:PHASE-1'), 'phase:PHASE-1', 'SVAR 为字符串 DOM id 添加的冒号前缀应被移除');
  assert.equal(decodeGanttDomTaskId('milestone:MILESTONE-1'), 'milestone:MILESTONE-1');

  const filtered = buildPlanGanttTasks(phases, milestones, features, { search: '甘特重构' });
  assert.deepEqual(filtered.map((item) => item.id), ['phase:PHASE-1', 'milestone:MILESTONE-1', 'feature:FEATURE-1']);
});

test('阶段与里程碑 API：兼容 goal/sort_order 与 canonical date 字段，并命中真实更新路由', async () => {
  const api = await vite.ssrLoadModule('/src/api.ts');
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (path, init = {}) => {
    const url = String(path);
    calls.push({ url, init });
    if (url === '/api/projects/PROJECT-A/phases' && !init.method) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: [{ phase_code: 'PHASE-1', project_code: 'PROJECT-A', name: '阶段', goal: '阶段摘要', sort_order: 7, start_date: '2026-08-11', end_date: '2026-08-29' }],
          };
        },
      };
    }
    if (url === '/api/projects/PROJECT-A/milestones' && !init.method) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: [{ milestone_code: 'MILESTONE-1', project_code: 'PROJECT-A', phase_code: 'PHASE-1', phase_name: '阶段', name: '里程碑', goal: '里程碑摘要', sort_order: 9, start_date: '2026-08-17', target_date: '2026-08-26' }],
          };
        },
      };
    }
    if (url === '/api/projects/PROJECT-A/phases' && init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: { phase_code: 'PHASE-2', project_code: 'PROJECT-A', name: '新阶段', goal: '新的阶段摘要', sort_order: 3, start_date: '2026-09-01', end_date: '2026-09-20', status: 'planned' },
          };
        },
      };
    }
    if (url === '/api/phases/PHASE-2' && init.method === 'PATCH') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: { phase_code: 'PHASE-2', project_code: 'PROJECT-A', name: '新阶段', goal: '更新后摘要', sort_order: 5, start_date: '2026-09-03', end_date: '2026-09-24', status: 'active' },
          };
        },
      };
    }
    if (url === '/api/projects/PROJECT-A/milestones' && init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: { milestone_code: 'MILESTONE-2', project_code: 'PROJECT-A', phase_code: 'PHASE-2', phase_name: '新阶段', name: '新里程碑', goal: '新的里程碑摘要', sort_order: 4, start_date: '2026-09-10', target_date: '2026-09-22', status: 'planned' },
          };
        },
      };
    }
    if (url === '/api/milestones/MILESTONE-2' && init.method === 'PATCH') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: { milestone_code: 'MILESTONE-2', project_code: 'PROJECT-A', phase_code: 'PHASE-2', phase_name: '新阶段', name: '新里程碑', goal: '更新后里程碑摘要', sort_order: 6, start_date: '2026-09-12', target_date: '2026-09-25', status: 'active' },
          };
        },
      };
    }
    throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`);
  };

  try {
    const phases = await api.listProjectPhases('PROJECT-A');
    const milestones = await api.listProjectMilestones('PROJECT-A');
    const createdPhase = await api.createProjectPhase('PROJECT-A', { name: '新阶段', summary: '新的阶段摘要', order: 3, start_at: '2026-09-01', end_at: '2026-09-20', status: 'planned' });
    const updatedPhase = await api.updateProjectPhase('PROJECT-A', 'PHASE-2', { summary: '更新后摘要', order: 5, start_at: '2026-09-03', end_at: '2026-09-24', status: 'active' });
    const createdMilestone = await api.createProjectMilestone('PROJECT-A', { name: '新里程碑', summary: '新的里程碑摘要', phase_code: 'PHASE-2', phase_name: '新阶段', order: 4, start_at: '2026-09-10', target_at: '2026-09-22', status: 'planned' });
    const updatedMilestone = await api.updateProjectMilestone('PROJECT-A', 'MILESTONE-2', { summary: '更新后里程碑摘要', order: 6, start_at: '2026-09-12', target_at: '2026-09-25', status: 'active' });

    assert.deepEqual(phases[0], {
      code: 'PHASE-1',
      project_code: 'PROJECT-A',
      name: '阶段',
      summary: '阶段摘要',
      status: 'planned',
      order: 7,
      start_at: '2026-08-11',
      end_at: '2026-08-29',
    });
    assert.deepEqual(milestones[0], {
      code: 'MILESTONE-1',
      project_code: 'PROJECT-A',
      phase_code: 'PHASE-1',
      phase_name: '阶段',
      name: '里程碑',
      summary: '里程碑摘要',
      status: 'planned',
      order: 9,
      start_at: '2026-08-17',
      target_at: '2026-08-26',
    });
    assert.equal(createdPhase.summary, '新的阶段摘要');
    assert.equal(updatedPhase.order, 5);
    assert.equal(createdMilestone.start_at, '2026-09-10');
    assert.equal(updatedMilestone.target_at, '2026-09-25');

    const createPhaseRequest = calls.find((entry) => entry.url === '/api/projects/PROJECT-A/phases' && entry.init.method === 'POST');
    const updatePhaseRequest = calls.find((entry) => entry.url === '/api/phases/PHASE-2' && entry.init.method === 'PATCH');
    const createMilestoneRequest = calls.find((entry) => entry.url === '/api/projects/PROJECT-A/milestones' && entry.init.method === 'POST');
    const updateMilestoneRequest = calls.find((entry) => entry.url === '/api/milestones/MILESTONE-2' && entry.init.method === 'PATCH');

    assert.deepEqual(JSON.parse(createPhaseRequest.init.body), {
      project_code: 'PROJECT-A',
      name: '新阶段',
      goal: '新的阶段摘要',
      sort_order: 3,
      status: 'planned',
      start_date: '2026-09-01',
      end_date: '2026-09-20',
    });
    assert.deepEqual(JSON.parse(updatePhaseRequest.init.body), {
      goal: '更新后摘要',
      sort_order: 5,
      status: 'active',
      start_date: '2026-09-03',
      end_date: '2026-09-24',
    });
    assert.deepEqual(JSON.parse(createMilestoneRequest.init.body), {
      project_code: 'PROJECT-A',
      name: '新里程碑',
      goal: '新的里程碑摘要',
      phase_code: 'PHASE-2',
      phase_name: '新阶段',
      sort_order: 4,
      status: 'planned',
      start_date: '2026-09-10',
      target_date: '2026-09-22',
    });
    assert.deepEqual(JSON.parse(updateMilestoneRequest.init.body), {
      goal: '更新后里程碑摘要',
      sort_order: 6,
      status: 'active',
      start_date: '2026-09-12',
      target_date: '2026-09-25',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('计划页：首屏收敛为单一开源甘特工作区，待规划项进入抽屉入口', async () => {
  const { ProjectPlanWorkbench } = await vite.ssrLoadModule('/src/ProjectPlanWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const projectCode = 'PROJECT-A';
  const client = new QueryClient();
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active', name: '协作平台' });
  client.setQueryData(['project-phases', projectCode], [
    { code: 'PHASE-1', project_code: projectCode, name: 'MVP 协作模型完善', summary: '本轮交付聚焦计划结构。', status: 'active', order: 1, start_at: '2026-08-10', end_at: '2026-09-15' },
    { code: 'PHASE-2', project_code: projectCode, name: '下一阶段', summary: null, status: 'archived', order: 2, start_at: null, end_at: null },
  ]);
  client.setQueryData(['project-milestones', projectCode], [
    { code: 'MILESTONE-1', project_code: projectCode, phase_code: 'PHASE-1', phase_name: 'MVP 协作模型完善', name: '需求结构与 Agent 执行上下文可用', summary: '支持上下文共享。', status: 'active', order: 1, start_at: '2026-08-15', target_at: '2026-08-28' },
    { code: 'MILESTONE-2', project_code: projectCode, phase_code: 'PHASE-2', phase_name: '下一阶段', name: '后续联调', summary: null, status: 'at_risk', order: 2, start_at: null, target_at: null },
  ]);
  client.setQueryData(['features', projectCode], [
    { code: 'FEATURE-1', project_code: projectCode, title: '项目功能结构与 Agent 执行上下文', goal: '提供完整上下文', status: 'draft', module_code: 'MODULE-1', module_name: '项目规划与需求结构', milestone_code: 'MILESTONE-1', milestone_name: '需求结构与 Agent 执行上下文可用', start_at: '2026-08-18', end_at: '2026-08-25' },
    { code: 'FEATURE-2', project_code: projectCode, title: '交接文档语义重构', goal: '区分需求与交接', status: 'draft', module_code: 'MODULE-2', module_name: '文档协作', milestone_code: null, milestone_name: null, start_at: null, end_at: null },
  ]);

  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(ProjectDisplayNamesProvider, { projectCode },
      createElement(ProjectPlanWorkbench, { projectCode }),
    ),
  ));

  assert.match(html, /协作平台 · 计划/);
  assert.match(html, /交付路线图/);
  assert.match(html, /aria-label="项目路线图"/);
  assert.match(html, /data-scale="week"/);
  assert.match(html, /计划结构/);
  assert.match(html, /时间尺度/);
  assert.match(html, /待规划/);
  assert.match(html, /双击阶段、里程碑或 Feature 行可编辑/);
  assert.match(html, />Feature</);
  assert.doesNotMatch(html, /里程碑窗口内独立排期/);
  assert.match(html, /下一阶段/, '默认应展示全部阶段而不是自动聚焦第一阶段');
  assert.doesNotMatch(html, /已选择阶段|已选择里程碑|已选择Feature/, '选择提示栏不应继续占用甘特图上方空间');
  assert.doesNotMatch(html, /阶段聚焦|排期范围|待规划 Feature<\/h2>/, '主页面不再堆叠阶段卡片和待规划大区');
  assert.doesNotMatch(html, /项目计划/);
  for (const role of ['member', 'viewer', 'admin']) {
    client.setQueryData(['project', projectCode], { code: projectCode, role, status: 'active' });
    const rendered = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectDisplayNamesProvider, { projectCode }, createElement(ProjectPlanWorkbench, { projectCode }))));
    if (role === 'admin') assert.match(rendered, /新建阶段/);
    else assert.doesNotMatch(rendered, /新建阶段|新建里程碑|双击阶段、里程碑或 Feature 行可编辑/);
    assert.match(rendered, /交付路线图/);
  }
  client.clear();
});

test('周视图的月份标记与周日期使用同一列宽基准', async () => {
  const { ganttScales } = await vite.ssrLoadModule('/src/ProjectPlanWorkbench.tsx');
  const scales = ganttScales('week', new Date('2026-07-25T00:00:00'));

  assert.deepEqual(scales.map((scale) => scale.unit), ['week', 'week']);
  assert.equal(scales[0].format(new Date('2026-07-19T00:00:00')), '2026年7月');
  assert.equal(scales[0].format(new Date('2026-07-26T00:00:00')), '');
  assert.equal(scales[0].format(new Date('2026-08-02T00:00:00')), '2026年8月');
  assert.equal(scales[1].format(new Date('2026-08-02T00:00:00')), '8/2');
});

test('交接页：多级文件夹组织接口等多份文档，并提供版本历史', async () => {
  const { ProjectDocumentsWorkbench } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const projectCode = 'PROJECT-A';
  const client = new QueryClient();
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active', name: '协作平台' });
  client.setQueryData(['handoff-library', projectCode, ''], {
    project_code: projectCode,
    can_create: true,
    folders: [
      { folder_code: 'FOLDER-1', parent_folder_code: null, name: '接口与联调', sort_order: 0, status: 'active', can_edit: true, created_at: 't0', updated_at: 't0' },
      { folder_code: 'FOLDER-2', parent_folder_code: 'FOLDER-1', name: '前后端对接', sort_order: 0, status: 'active', can_edit: true, created_at: 't0', updated_at: 't0' },
    ],
    documents: [{ document_code: 'DOC-A', folder_code: 'FOLDER-2', folder_name: '前后端对接', kind: 'api', title: '登录接口协议', summary: '说明前后端联调方式。', current_revision: 2, status: 'active', updated_by_user_code: 'USER-A', updated_at: '2026-08-17T06:00:00.000Z', can_edit: true }],
  });
  client.setQueryData(['handoff-document', 'DOC-A'], {
    document_code: 'DOC-A', project_code: projectCode, folder_code: 'FOLDER-2', folder_name: '前后端对接', kind: 'api', title: '登录接口协议', summary: '说明前后端联调方式。', content: '# 登录接口\n\n## 请求\n\nPOST /auth/login', current_revision: 2, status: 'active', updated_by_user_code: 'USER-A', updated_at: '2026-08-17T06:00:00.000Z', can_edit: true, outline: [],
    revisions: [{ revision_code: 'REV-2', revision: 2, title: '登录接口协议', summary: '说明前后端联调方式。', content: '# 登录接口', change_summary: '补充错误码', created_by_user_code: 'USER-A', created_at: '2026-08-17T06:00:00.000Z' }],
  });

  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(ProjectDisplayNamesProvider, { projectCode },
      createElement(ProjectDocumentsWorkbench, { projectCode }),
    ),
  ));

  assert.match(html, /协作平台 · 文档/);
  assert.match(html, /文档库/);
  assert.match(html, /接口与联调/);
  assert.match(html, /前后端对接/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /收起文件夹/);
  assert.match(html, /登录接口协议/);
  assert.match(html, />api<\/span>/);
  assert.match(html, /版本记录/);
  assert.match(html, /新建文件夹/);
  assert.match(html, /新建文档/);
  assert.doesNotMatch(html, /完整项目文档|完整正文会成为 Web 与 CLI 共用的项目上下文/);
});

test('项目首页进入文档库时展示指定文档，而非列表首篇', async () => {
  const { ProjectDocumentsWorkbench } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const projectCode = 'PROJECT-HOME';
  const client = new QueryClient();
  const docs = ['FIRST', 'STANDARDS'].map((code) => ({
    document_code: code, project_code: projectCode, folder_code: null, kind: 'general',
    title: code, summary: '', content: code === 'STANDARDS' ? '项目规范专属正文' : '首篇普通文档正文',
    current_revision: 1, status: 'active', updated_at: '2026-10-15T00:00:00Z',
    can_edit: false, revisions: [], outline: [],
  }));
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active', name: '首页测试' });
  client.setQueryData(['handoff-library', projectCode, ''], { project_code: projectCode, can_create: false, folders: [], documents: docs });
  for (const doc of docs) client.setQueryData(['handoff-document', doc.document_code], doc);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(ProjectDisplayNamesProvider, { projectCode },
      createElement(ProjectDocumentsWorkbench, { projectCode, documentCode: 'STANDARDS' }),
    ),
  ));
  assert.match(html, /项目规范专属正文/);
  assert.doesNotMatch(html, /首篇普通文档正文/);
  client.setQueryData(['handoff-document', 'STANDARDS'], { ...docs[1], project_code: 'ANOTHER-PROJECT' });
  const mismatched = renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(ProjectDisplayNamesProvider, { projectCode },
      createElement(ProjectDocumentsWorkbench, { projectCode, documentCode: 'STANDARDS' }),
    ),
  ));
  assert.match(mismatched, /该文档不属于当前项目/);
  assert.doesNotMatch(mismatched, /项目规范专属正文/);
});

test('任务详情：资料引用明确标注项目文档', async () => {
  const { TaskDetail } = await vite.ssrLoadModule('/src/TaskDetail.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['task-handovers', 'TASK-A'], []);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TaskDetail, {
    task: {
      code: 'TASK-A',
      project_code: 'PROJECT-A',
      feature_code: 'FEATURE-A',
      brief: 'brief',
      title: '交接文案校验',
      profile: 'builder',
      source: 'requirement',
      status: 'assigned',
      assignee_code: null,
      acceptance: [],
      base_snapshot: 1,
      project_document_code: 'DOC-A',
      requirement_code: null,
      requirement_document_code: null,
      requirement_title: null,
      requirement_body: null,
      requirement_acceptance_criteria: [],
      requirement_open_questions: [],
      defect_code: null,
      derived_view: 'draft',
      assignee_principal_code: null,
      validation_seams: [],
      scope: null,
      runs: [],
      evidences: [],
      artifacts: [],
      evidence_count: 0,
      artifact_count: 0,
    },
    events: [],
    stale: false,
  })));

  assert.match(html, /项目文档/);
  assert.doesNotMatch(html, /交接文档/);
});

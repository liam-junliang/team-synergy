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

test('任务卡片为长标题和状态标签保留独立布局空间', async () => {
  const { TaskCard } = await vite.ssrLoadModule('/src/App.tsx');
  const html = renderToStaticMarkup(createElement(TaskCard, {
    task: {
      code: 'ABCDEFGHIJKLMNOPQRST',
      project_code: 'PROJECT-ALPHA',
      feature_code: 'QRSTUVWXYZABCDEFGHIJ',
      brief: '# 一页简报\n\n- 第一段\n- 第二段\n\n`代码` [链接](https://example.com)\n\n超长连续字符ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      title: 'Requirement/Orchestration/Acceptance workflow with an-uninterrupted-extra-long-token',
      profile: 'builder',
      source: 'requirement',
      status: 'closed',
      assignee_code: 'KLMNOPQRSTUVWXYZABCD',
      acceptance: [],
      base_snapshot: 1,
      project_document_code: null,
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
    onSelect() {},
  }));

  assert.match(html, /grid-cols-\[minmax\(0,1fr\)_auto\]/, '标题和状态应使用有界网格布局');
  assert.match(html, /\[overflow-wrap:anywhere\]/, '不可断开的长标题也必须能在卡片内换行');
  assert.match(html, /whitespace-nowrap/, '状态文案不应被压缩换行');
  assert.match(html, /truncate/, '次要的负责人和 Feature 信息应截断而非溢出');
  assert.match(html, /display:-webkit-box/, 'brief 摘要应使用原生 line-clamp 盒模型');
  assert.match(html, /overflow:hidden/, 'brief 摘要应显式隐藏溢出');
  assert.match(html, /-webkit-line-clamp:2/, 'brief 摘要应限制为两行');
  assert.match(html, /一页简报 第一段 第二段 代码 链接 超长连续字符ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/, 'brief 应清洗 Markdown 并合并空白');
  assert.doesNotMatch(html, /#{1,6}\s|```|\[[^\]]+\]\([^)]+\)|^\s*-\s/m, 'brief 摘要不应暴露 Markdown 语法');
});

test('任务卡 brief 清洗逻辑会移除 Markdown 标记并压缩空白', async () => {
  const { summarizeTaskBrief } = await vite.ssrLoadModule('/src/taskCardSummary.ts');

  const summary = summarizeTaskBrief('# 标题\n\n- 第一项\n- 第二项\n\n`代码` [链接](https://example.com)\n\n   多余   空白  ');

  assert.equal(summary, '标题 第一项 第二项 代码 链接 多余 空白');
});

test('任务筛选栏常驻区保持紧凑，组合条件只在弹层中出现', async () => {
  const { TaskBoardControls } = await vite.ssrLoadModule('/src/App.tsx');
  const renderControls = (timeOrder = 'newest') => renderToStaticMarkup(createElement(TaskBoardControls, {
      filters: {
        keyword: '',
        featureCode: '',
        assigneeCode: '',
        source: '',
        timeOrder,
      },
      setFilters() {},
      featureOptions: ['FEATURE-CODE'],
      assigneeOptions: ['MEMBER-CODE'],
      sourceOptions: ['requirement'],
      featureName: () => '任务闭环',
      memberName: () => 'Liam',
    }));
  const html = renderControls();

  assert.match(html, /aria-label="任务筛选与排序"/, '筛选和排序仍应属于同一个可访问区域');
  assert.match(html, /w-\[250px\]/, '搜索框应使用紧凑固定宽度，而不是占满整行');
  assert.match(html, /placeholder="搜索任务"/, '搜索入口应保留在常驻区');
  assert.match(html, />筛选</, '组合筛选应收进单一入口');
  assert.match(html, /时间倒序/, '时间排序应使用明确的倒序方向文案');
  assert.match(html, /点击切换为时间正序/, '时间排序按钮应说明点击后的切换方向');
  assert.doesNotMatch(html, /<select[^>]+按时间排序/, '时间排序不应继续使用下拉框');
  assert.doesNotMatch(html, /按 Feature 筛选|按负责人筛选|按任务来源筛选/, '未展开时不应渲染三组常驻下拉框');
  assert.doesNotMatch(html, /全部 Feature|全部负责人|全部来源/, '组合条件文案不应占用看板首屏');

  const changedHtml = renderControls('oldest');
  assert.ok(
    changedHtml.indexOf('aria-label="重置筛选与排序"') < changedHtml.indexOf('aria-label="搜索任务"'),
    '存在筛选变更时，重置按钮应显示在搜索框左侧',
  );
});

test('Feature 与负责人筛选从项目目录补全，并保留任务中的历史值', async () => {
  const { collectTaskBoardAssigneeOptions, collectTaskBoardFeatureOptions } = await vite.ssrLoadModule('/src/App.tsx');
  const features = collectTaskBoardFeatureOptions(
    [{ code: 'FEATURE-WITHOUT-TASK' }],
    [{ feature_code: 'HISTORICAL-FEATURE' }],
    (code) => code,
  );
  const assignees = collectTaskBoardAssigneeOptions(
    [{ code: 'NEW-MEMBER' }],
    [{ assignee_code: 'FORMER-MEMBER' }],
    (code) => code,
  );

  assert.deepEqual(features, ['FEATURE-WITHOUT-TASK', 'HISTORICAL-FEATURE'], '尚无任务的新 Feature 也应出现在筛选项中');
  assert.deepEqual(assignees, ['FORMER-MEMBER', 'NEW-MEMBER'], '尚未领取任务的新成员也应出现在负责人筛选中');
});

test('任务详情以概览、合同、需求与审计时间线组织信息', async () => {
  const { TaskDetail } = await vite.ssrLoadModule('/src/TaskDetail.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['task-handovers', 'ABCDEFGHIJKLMNOPQRST'], []);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TaskDetail, {
    task: {
      code: 'ABCDEFGHIJKLMNOPQRST',
      project_code: 'PROJECT-ALPHA',
      feature_code: 'QRSTUVWXYZABCDEFGHIJ',
      brief: '### 简报标题\n\n- 项目目标\n- 验收提醒',
      title: 'Requirement/Orchestration/Acceptance workflow with an-uninterrupted-extra-long-token',
      profile: 'builder',
      source: 'requirement',
      status: 'closed',
      assignee_code: 'KLMNOPQRSTUVWXYZABCD',
      acceptance: [
        { id: 'AC-1', text: '状态标签始终保持在详情面板边界内' },
        { id: 'AC-2', text: '长内容可以稳定换行且不挤压主要操作' },
      ],
      base_snapshot: 12,
      project_document_code: 'PDOC-PLAN',
      requirement_code: 'REQ-DETAIL',
      requirement_document_code: 'RDOC-DETAIL',
      requirement_title: '完整执行简报',
      requirement_body: '## 需求正文\n\n说明执行上下文。',
      requirement_acceptance_criteria: [{ id: 'RAC-1', text: '保留完整上下文字段' }],
      requirement_open_questions: ['是否需要补交互约束？'],
      defect_code: null,
      derived_view: 'verified',
      assignee_principal_code: 'KLMNOPQRSTUVWXYZABCD',
      validation_seams: ['apps/web/src/TaskDetail.tsx'],
      scope: { writable_paths: ['apps/web/src/**'] },
      runs: [{
        run_code: 'RUN-DETAIL-1',
        workspace_code: 'WORKSPACE-DETAIL',
        workspace_path: 'F:/workspace/detail',
        git_base: 'abc123',
        status: 'active',
        profile: 'builder',
        principal_code: 'KLMNOPQRSTUVWXYZABCD',
        base_snapshot: 12,
        started_at: '2026-08-17T01:00:00.000Z',
        finished_at: null,
      }],
      evidences: [{
        evidence_code: 'EVID-DETAIL-1',
        run_code: 'RUN-DETAIL-1',
        type: 'self_test',
        acceptance_refs: ['AC-1'],
        result: 'pass',
        command: 'pnpm test',
        summary: '验证通过',
        report_uri: 'file:///tmp/report.md',
        recorded_at: '2026-08-17T02:00:00.000Z',
      }],
      artifacts: [{
        artifact_code: 'ART-DETAIL-1',
        project_code: 'PROJECT-ALPHA',
        run_code: 'RUN-DETAIL-1',
        kind: 'report',
        title: '交付报告',
        summary: '完整交付摘要',
        uri: 'file:///tmp/report.md',
        content_hash: 'abc',
        published: true,
        published_at: '2026-08-17T03:00:00.000Z',
      }],
      evidence_count: 1,
      artifact_count: 1,
    },
    events: [{
      timestamp: '2026-08-14T03:00:00.000Z',
      action: 'task.closed',
      principal_code: 'EFGHIJKLMNOPQRSTUVWX',
      run_code: null,
      from: 'verified',
      to: 'closed',
      base_snapshot: 12,
    }],
    stale: false,
  })));

  assert.match(html, /aria-label="任务概览"/, '详情应有独立的任务概览区');
  assert.match(html, /grid-cols-\[minmax\(0,1\.15fr\)_minmax\(260px,0\.85fr\)\]/, '验收标准和审计时间线应使用响应式双栏布局');
  assert.match(html, /\[overflow-wrap:anywhere\]/, '详情中的长标题和标识符应能安全换行');
  assert.match(html, /aria-labelledby="contract-heading"/, '任务合同应有清晰的结构标签');
  assert.match(html, /aria-labelledby="requirement-heading"/, '关联需求应有清晰的结构标签');
  assert.match(html, /aria-labelledby="runs-heading"/, '执行 Runs 应有清晰的结构标签');
  assert.match(html, /aria-labelledby="evidence-heading"/, '验证证据应有清晰的结构标签');
  assert.match(html, /aria-labelledby="artifacts-heading"/, '交付产物应有清晰的结构标签');
  assert.match(html, /aria-labelledby="timeline-heading"/, '审计时间线应有清晰的结构标签');
  assert.match(html, /任务简报/, '详情应提供单独的任务简报区');
  assert.match(html, /简报标题/, '任务简报应渲染 Markdown 内容');
});

test('交接面板用中文工作记录和固定版本资料帮助接手，完成态隐藏所有变更操作', async () => {
  const { HandoverPanel } = await vite.ssrLoadModule('/src/HandoverPanel.tsx');
  const task = { code: 'TASK-HANDOVER', project_code: 'PROJECT-HANDOVER', runs: [] };
  const item = {
    handover_code: 'HANDOVER-EXAMPLE', task_code: task.code, status: 'preparing', version: 2,
    source_user_code: 'SOURCE', target_user_code: 'TARGET', source_run_code: 'RUN-SOURCE',
    context_snapshot_code: 'CONTEXT-FIXED', context_snapshot_hash: 'a'.repeat(64),
    summary: { goal: '接续登录实现', completed: ['已实现登录接口'], remaining: ['补充并发测试'],
      next_actions: ['阅读固定需求'], assumptions: ['锁定时长待确认'], failed_attempts: ['定时器方案存在竞态'] },
    workspace_manifest: { snapshot_commit: 'b'.repeat(40) }, stop_ack: { stopped: true },
    can_publish: true, can_accept: false, can_cancel: true, can_approve_drift: true,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['project', task.project_code], { code: task.project_code, role: 'member', status: 'active' });
  client.setQueryData(['task-handovers', task.code], [item]);
  client.setQueryData(['handover', item.handover_code], item);
  client.setQueryData(['handover-context', item.context_snapshot_code], { manifest: { sources: [
    { kind: 'requirement', code: 'REQ-1', title: '登录功能', revision: 1, content: '## 统一错误响应\n\n保护账号信息。', acceptance: [{ id: 'AC-1', text: '错误响应保持一致' }] },
    { kind: 'prototype', code: 'PROTOTYPE-1', title: '登录界面', revision: 3, html_content: '<script>untrusted()</script>' },
  ] } });
  client.setQueryData(['handover-context-diff', item.context_snapshot_code], {
    changes: [], baseline_conflicts: [{ source: 'requirement:REQ-1', pinned_revision: 1, current_revision: 2 }], source_changed: true,
  });
  const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(HandoverPanel, { task })));
  const html = render();
  for (const text of ['交接目标', '接续登录实现', '已完成', '已实现登录接口', '待完成', '建议下一步', '当前假设', '失败尝试', '登录功能', '修订 1', '统一错误响应', '错误响应保持一致', '共享资料存在版本差异', '任务固定修订 1', '当前为修订 2', '发布交接', '记录确认与理由']) {
    assert.ok(html.includes(text), `应展示 ${text}`);
  }
  assert.doesNotMatch(html, /<script>/, '原型 HTML 只作为资料保存，不能执行');
  assert.match(html, /高级信息：快照清单与完整性校验/, '底层 JSON 应收在高级信息中');
  client.setQueryData(['handover', item.handover_code], { ...item, status: 'completed' });
  const completed = render();
  assert.match(completed, /已接手/);
  assert.doesNotMatch(completed, />发布交接<|>接收交接<|>取消交接<|>记录确认与理由</);
  client.clear();
});

test('项目工作台以业务名称作为主文案，编码仅保留为辅助信息', async () => {
  const { TaskDetail } = await vite.ssrLoadModule('/src/TaskDetail.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const projectCode = 'ABCDEFGHIJKLMNOPQRST';
  const featureCode = 'QRSTUVWXYZABCDEFGHIJ';
  const memberCode = 'KLMNOPQRSTUVWXYZABCD';
  const client = new QueryClient();
  client.setQueryData(['project', projectCode], { code: projectCode, name: '协作平台' });
  client.setQueryData(['features', projectCode], [{ code: featureCode, title: '任务闭环' }]);
  client.setQueryData(['members', projectCode], [{ code: memberCode, display_name: '王构建' }]);
  client.setQueryData(['requirements', projectCode], []);

  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(ProjectDisplayNamesProvider, { projectCode },
      createElement(TaskDetail, {
        task: {
          code: '0123456789ABCDEFGHJK',
          project_code: projectCode,
          feature_code: featureCode,
          brief: '只保留名称作为主文案',
          title: '完成任务名称展示',
          profile: 'builder',
          source: 'requirement',
          status: 'assigned',
          assignee_code: memberCode,
          acceptance: [],
          base_snapshot: 1,
          project_document_code: null,
          requirement_code: null,
          requirement_document_code: null,
          requirement_title: null,
          requirement_body: null,
          requirement_acceptance_criteria: [],
          requirement_open_questions: [],
          defect_code: null,
          derived_view: 'draft',
          assignee_principal_code: memberCode,
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
      }),
    ),
  ));

  assert.match(html, />任务闭环</, 'Feature 应显示标题');
  assert.match(html, new RegExp(`<code class="shrink-0 font-mono text-\\[10px\\] opacity-70">${featureCode}</code>`), 'Feature 编码应作为次级信息显示');
  assert.match(html, />王构建</, '负责人应显示成员名称');
  assert.doesNotMatch(html, new RegExp(`>${memberCode}<`), '成员编码不应成为可见主文案');
});

test('任务详情接口使用公开任务详情路由并保留上下文字段', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [];
  globalThis.fetch = async (input) => {
    responses.push(String(input));
    return new Response(JSON.stringify({
      ok: true,
      data: {
        task_code: 'TASK-STATUS-1',
        feature_code: 'FEATURE-1',
        project_code: 'PROJECT-1',
        project_document_code: 'PDOC-1',
        requirement_code: 'REQ-1',
        requirement_document_code: 'RDOC-1',
        requirement_title: '需求标题',
        requirement_body: '需求正文',
        requirement_acceptance_criteria: [{ id: 'RAC-1', text: '保留字段' }],
        requirement_open_questions: ['待确认'],
        defect_code: null,
        title: '任务标题',
        brief: '任务简报',
        profile: 'builder',
        source: 'requirement',
        status: 'draft',
        derived_view: 'submitted',
        assignee_principal_code: 'PRINCIPAL-1',
        acceptance: [{ id: 'AC-1', text: '任务验收' }],
        validation_seams: ['apps/web/src/TaskDetail.tsx'],
        scope: { writable_paths: ['apps/web/src/**'] },
        base_snapshot: 7,
        runs: [{
          run_code: 'RUN-1',
          workspace_code: 'WORK-1',
          workspace_path: 'F:/workspace/1',
          git_base: 'abc123',
          status: 'active',
          profile: 'builder',
          principal_code: 'PRINCIPAL-1',
          base_snapshot: 7,
          started_at: '2026-08-17T01:00:00.000Z',
          finished_at: null,
        }],
        evidences: [{
          evidence_code: 'EVID-1',
          run_code: 'RUN-1',
          type: 'self_test',
          acceptance_refs: ['AC-1'],
          result: 'pass',
          command: 'pnpm test',
          summary: '通过',
          report_uri: 'file:///tmp/report.md',
          recorded_at: '2026-08-17T02:00:00.000Z',
        }],
        artifacts: [{
          artifact_code: 'ART-1',
          project_code: 'PROJECT-1',
          run_code: 'RUN-1',
          kind: 'report',
          title: '报告',
          summary: '摘要',
          uri: 'file:///tmp/report.md',
          content_hash: 'deadbeef',
          published: true,
          published_at: '2026-08-17T03:00:00.000Z',
        }],
        evidence_count: 1,
        artifact_count: 1,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const { getTask } = await vite.ssrLoadModule('/src/api.ts');
    const task = await getTask('TASK-STATUS-1');
    assert.equal(responses[0], '/api/tasks/TASK-STATUS-1', 'Web 详情请求应使用独立的 /api 命名空间');
    assert.equal(task.project_code, 'PROJECT-1');
    assert.equal(task.project_document_code, 'PDOC-1');
    assert.equal(task.requirement_code, 'REQ-1');
    assert.equal(task.requirement_document_code, 'RDOC-1');
    assert.equal(task.requirement_title, '需求标题');
    assert.equal(task.requirement_body, '需求正文');
    assert.equal(task.validation_seams[0], 'apps/web/src/TaskDetail.tsx');
    assert.equal(task.scope?.writable_paths[0], 'apps/web/src/**');
    assert.equal(task.runs[0].workspace_code, 'WORK-1');
    assert.equal(task.evidences[0].evidence_code, 'EVID-1');
    assert.equal(task.artifacts[0].artifact_code, 'ART-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MarkdownDocument 可以使用显式 outline 锚点稳定生成目录链接', async () => {
  const { MarkdownDocument } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const html = renderToStaticMarkup(createElement(MarkdownDocument, {
    content: '# 总览\n\n## 设计目标\n\n正文内容',
    outline: [
      { level: 1, title: '总览', anchor: 'custom-overview' },
      { level: 2, title: '设计目标', anchor: 'custom-target' },
    ],
  }));

  assert.match(html, /id="custom-overview"/, '主标题应使用传入的锚点');
  assert.match(html, /id="custom-target"/, '子标题应使用传入的锚点');
});

test('看板右侧信息栏组织交付概览、阶段分布和同步状态', async () => {
  const { BoardInsights } = await vite.ssrLoadModule('/src/App.tsx');
  const html = renderToStaticMarkup(createElement(BoardInsights, {
    total: 43,
    completed: 18,
    columns: [
      { id: 'backlog', title: '待处理', count: 21 },
      { id: 'todo', title: '已分派', count: 3 },
      { id: 'doing', title: '执行中', count: 1 },
      { id: 'review', title: '验收', count: 0 },
      { id: 'done', title: '已完成', count: 18 },
    ],
    updatedAt: Date.parse('2026-08-14T05:00:00Z'),
    isFetching: false,
  }));

  assert.match(html, /aria-label="看板交付概览"/, '右侧信息栏应有独立的结构标签');
  assert.match(html, /交付概览/, '应集中展示团队交付进度');
  assert.match(html, /阶段分布/, '应展示各看板阶段的任务分布');
  assert.match(html, /数据同步/, '应说明任务数据来源及同步状态');
  assert.match(html, />42%</, '完成率应由完成任务数和总任务数计算');
});

import { randomUUID } from 'node:crypto';
import { DomainError } from '@team-synergy/domain';
import type { createHostedCodeAnalysisUseCases } from '@team-synergy/application';
import type { CodeArtifact, CodePlugin, CodeSnapshot } from '@team-synergy/contracts';
import type { SemanticProgress } from './code-analysis-semantic-source.js';

type Store = ReturnType<typeof createHostedCodeAnalysisUseCases>;
export interface CodeAnalysisExecutor {
  status(): { configured: boolean; plugins: CodePlugin[] };
  execute(input: { jobCode: string; projectCode: string; repository: { code: string; name: string; remote_url: string; default_branch: string } },
    options: { signal: AbortSignal; onSnapshot: (snapshot: CodeSnapshot) => Promise<void>; onProgress: (progress: SemanticProgress) => Promise<void> }): Promise<{
      artifact: CodeArtifact; plugins: CodePlugin[]; execution_metadata: Record<string, unknown>;
    }>;
}

/** PostgreSQL owns the queue and fences completion. Long-running IO never holds a DB transaction. */
export function createCodeAnalysisWorker(options: {
  store: Store; runtime: CodeAnalysisExecutor; pollMs?: number; heartbeatMs?: number; onError?: (code: string) => void;
}) {
  const executorId = `code-analysis:${randomUUID()}`;
  let stopped = true;
  let pending: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let active: AbortController | null = null;

  async function runNext() {
    const recovered = await options.store.recoverExpiredJobs();
    if (!recovered.ok) { options.onError?.(recovered.error.code); return; }
    if (stopped) return;
    const configuration = options.runtime.status();
    if (!configuration.configured) return;
    const claimed = await options.store.claimNextJob({ executorId });
    if (!claimed.ok) { options.onError?.(claimed.error.code); return; }
    if (!claimed.data) return;
    const job = claimed.data;
    const capability = { jobCode: job.jobCode, executorId, executionToken: job.executionToken };
    const controller = new AbortController();
    active = controller;
    if (stopped) controller.abort();
    let renewing: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = options.store.heartbeatJob(capability).then(response => {
        if (!response.ok || !response.data.active) controller.abort();
      }).catch(() => controller.abort()).finally(() => { renewing = null; });
    }, options.heartbeatMs ?? 10_000);
    heartbeat.unref();
    let stage = '准备';
    let reporting = Promise.resolve();
    try {
      const attached = await options.store.attachRun({ ...capability, plugins: configuration.plugins });
      if (!attached.ok) { options.onError?.(attached.error.code); throw new Error('Run unavailable'); }
      if (controller.signal.aborted) throw new Error('Cancelled');
      stage = '拉取仓库或分析';
      const output = await options.runtime.execute({ jobCode: job.jobCode, projectCode: job.projectCode, repository: job.repository }, {
        signal: controller.signal,
        onSnapshot: async snapshot => {
          if (controller.signal.aborted) throw new Error('Cancelled');
          const updated = await options.store.progressJob({ ...capability, status: 'indexing', snapshot });
          if (!updated.ok) { options.onError?.(updated.error.code); controller.abort(); throw new Error('Lease unavailable'); }
        },
        onProgress: progress => {
          const stages = { files: '全仓文件分析', reduce: '文件事实整合', consistency: '跨文件事实核验', architecture: '模块与业务综合', tour: '项目导览', review: '综合结果核验' };
          stage = stages[progress.phase];
          const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
          const message = `${stage} ${count(progress.completed)}/${count(progress.total)}；分段 ${count(progress.completed_segments)}/${count(progress.total_segments)}；文件 ${count(progress.completed_files)}/${count(progress.total_files)}`;
          reporting = reporting.then(async () => {
            if (controller.signal.aborted) throw new Error('Cancelled');
            const updated = await options.store.progressJob({ ...capability, status: 'awaiting_agent', message });
            if (!updated.ok) { options.onError?.(updated.error.code); controller.abort(); throw new Error('Lease unavailable'); }
          });
          return reporting;
        },
      });
      await reporting;
      if (controller.signal.aborted) throw new Error('Cancelled');
      if (JSON.stringify(output.plugins) !== JSON.stringify(attached.data.plugins)) throw new Error('Engine changed');
      stage = '校验或发布';
      const validating = await options.store.progressJob({ ...capability, status: 'validating' });
      if (!validating.ok) { options.onError?.(validating.error.code); throw new Error('Lease unavailable'); }
      const completed = await options.store.completeJob({ ...capability, runCode: attached.data.code,
        artifact: output.artifact, executionMetadata: output.execution_metadata });
      if (!completed.ok) { options.onError?.(completed.error.code); throw new Error('Publication rejected'); }
    } catch (error) {
      if (error instanceof DomainError && /^code_[a-z_]+$/.test(error.code)) options.onError?.(error.code);
      const failed = await options.store.failJob({ ...capability, message: controller.signal.aborted
        ? '服务端分析已中止或执行租约失效，可重新发起；上一份主线结果仍保留。'
        : `服务端代码分析在${stage}阶段失败，请检查服务配置后重试；上一份主线结果仍保留。` });
      if (!failed.ok && failed.error.code !== 'code_understanding_execution_expired') options.onError?.(failed.error.code);
    } finally {
      clearInterval(heartbeat);
      await renewing;
      await reporting.catch(() => undefined);
      if (active === controller) active = null;
    }
  }
  function tick() {
    if (stopped || pending) return;
    pending = runNext().catch(() => options.onError?.('code_analysis_worker_failed')).finally(() => { pending = null; });
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      interval = setInterval(tick, options.pollMs ?? 2_000);
      interval.unref();
      tick();
    },
    async stop() {
      stopped = true;
      if (interval) clearInterval(interval);
      interval = null;
      active?.abort();
      await pending;
    },
  };
}

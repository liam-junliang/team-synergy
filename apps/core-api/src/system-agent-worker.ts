import { randomUUID } from 'node:crypto';
import type { createSystemAgentUseCases } from '@team-synergy/application';
import type { SystemAgentProposal } from '@team-synergy/contracts';
import { SystemAgentRuntimeError } from './system-agent-runtime.js';

type Store = ReturnType<typeof createSystemAgentUseCases>;

/** Internal interface: the runtime only sees authorized snapshots, never platform credentials. */
export interface SystemAgentExecutor {
  generate(input: {
    jobCode: string;
    document: { code: string; revision: number; title: string; summary: string; content: string };
    instruction: string;
    quote?: string;
    guidance?: string;
  }, options?: { signal?: AbortSignal }): Promise<SystemAgentProposal>;
}

export interface SystemAgentWorkerOptions {
  store: Store;
  runtime: SystemAgentExecutor;
  guidance: string;
  executionMetadata: { engine: string; engine_version: string; model: string; skill_version: string; skill_sha256: string };
  pollMs?: number;
  heartbeatMs?: number;
  onError?: (code: string) => void;
}

/** One bounded job at a time. PostgreSQL owns recovery, leases and terminal states. */
export function createSystemAgentWorker(options: SystemAgentWorkerOptions) {
  const executorId = `system-agent:${randomUUID()}`;
  let stopped = true;
  let pending: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let abort: AbortController | null = null;

  async function runNext() {
    const recovered = await options.store.recoverExpiredJobs();
    if (!recovered.ok) { options.onError?.(recovered.error.code); return; }
    if (stopped) return;
    const claimed = await options.store.claimNextJob({ executorId, executionMetadata: options.executionMetadata });
    if (!claimed.ok) { options.onError?.(claimed.error.code); return; }
    if (!claimed.data) return;
    const job = claimed.data;
    const capability = { jobCode: job.job_code, executorId, executionToken: job.execution_token };
    const controller = new AbortController();
    abort = controller;
    if (stopped) controller.abort();
    let heartbeatBusy = false;
    let heartbeatPending: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || controller.signal.aborted) return;
      heartbeatBusy = true;
      heartbeatPending = (async () => {
        try {
          const renewed = await options.store.heartbeatJob(capability);
          if (!renewed.ok) controller.abort();
        } catch { controller.abort(); }
        finally { heartbeatBusy = false; }
      })();
    }, options.heartbeatMs ?? 10_000);
    heartbeat.unref();
    try {
      const proposal = await options.runtime.generate({
        jobCode: job.job_code,
        document: { code: job.document_code, revision: job.base_revision, title: job.base_title, summary: job.base_summary, content: job.base_content },
        instruction: job.instruction, ...(job.quote ? { quote: job.quote } : {}), guidance: options.guidance,
      }, { signal: controller.signal });
      // A cancelled/lost lease must not publish a late model response.
      if (controller.signal.aborted) throw new Error('系统 Agent 执行已中止，请按最新资料重新发起');
      const completed = await options.store.completeJob({ ...capability, proposal });
      if (!completed.ok) {
        options.onError?.(completed.error.code);
        await options.store.failJob({ ...capability, message: '修改稿未通过接收校验，或执行权限已失效；请重新发起' });
      }
    } catch (error) {
      // Only known adapter errors are safe for display. Filesystem/DB exceptions can include secrets.
      const message = controller.signal.aborted ? '系统 Agent 执行已中止，请重新发起'
        : error instanceof SystemAgentRuntimeError ? error.message : '系统 Agent 执行失败，请重试或联系平台管理员';
      if (!(error instanceof SystemAgentRuntimeError) && !controller.signal.aborted) options.onError?.('system_agent_execution_failed');
      const failed = await options.store.failJob({ ...capability, message });
      if (!failed.ok && failed.error.code !== 'system_agent_execution_expired') options.onError?.(failed.error.code);
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
      if (abort === controller) abort = null;
    }
  }

  function tick() {
    if (stopped || pending) return;
    pending = runNext().catch(() => options.onError?.('system_agent_worker_failed')).finally(() => { pending = null; });
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
      abort?.abort();
      await pending;
    },
  };
}

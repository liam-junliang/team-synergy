import type { MemoryModelObservation, MemoryModelStatus } from '@team-synergy/contracts';

// Service-process counters only. No source text, actor, URL, key or model output
// is stored; completed capture jobs are never used as model-call evidence.
const observation: MemoryModelObservation = { scope: 'service_process', startedAt: new Date().toISOString(), attempts: 0, successes: 0, errors: 0 };
export function beginMemoryModelRequest() {
  observation.attempts++;
  observation.lastAttemptAt = new Date().toISOString();
  let completed = false;
  return (success: boolean) => {
    if (completed) return;
    completed = true;
    if (success) { observation.successes++; observation.lastSuccessAt = new Date().toISOString(); }
    else { observation.errors++; observation.lastErrorAt = new Date().toISOString(); }
  };
}

export function memoryModelStatus(canViewServiceObservations: boolean): MemoryModelStatus {
  const provider = process.env.TSP_MEMORY_PROVIDER ?? 'ollama', model = process.env.TSP_MEMORY_MODEL || 'hub-qwen2.5:latest';
  return { provider: ['ollama', 'openai'].includes(provider) ? provider : 'invalid-configuration',
    model: /^[a-zA-Z0-9._:/-]{1,160}$/u.test(model) ? model : 'invalid-configuration',
    providerSource: process.env.TSP_MEMORY_PROVIDER === undefined ? 'default' : 'explicit',
    modelSource: process.env.TSP_MEMORY_MODEL ? 'explicit' : 'default',
    observationScope: 'system_admin_only', ...(canViewServiceObservations ? { observation: { ...observation } } : {}) };
}

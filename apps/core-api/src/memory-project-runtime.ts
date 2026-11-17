import { createMemoryProjectManagementUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import type { EngineConfig } from './memory-engines.js';

/** Persisted controls take precedence, including an explicit pause of a legacy mapping. */
export async function resolveProjectMemoryEngines(db: Db, config: EngineConfig, projectCode: string) {
  const binding = await createMemoryProjectManagementUseCases(db).binding(projectCode);
  if (!binding) return { config, generation: null };
  const projects = { ...config.projects };
  delete projects[projectCode];
  if (binding.enabled && binding.state === 'ready' && binding.wikiId && binding.teamId && binding.userId) {
    projects[projectCode] = { wikiId: binding.wikiId, teamId: binding.teamId, userId: binding.userId,
      ...(binding.semanticAgentId ? { semanticAgentId: binding.semanticAgentId } : {}) };
  }
  return { config: { ...config, projects }, generation: binding.generation };
}

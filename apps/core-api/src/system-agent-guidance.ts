import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface SystemAgentGuidance { version: string; sha256: string; guidance: string }
export const SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS = 60_000;
export const SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES = 80_000;

export function loadSystemAgentGuidance(url?: URL): SystemAgentGuidance {
  const besideModule = new URL('./system-agent-skill.json', import.meta.url);
  // tsx watch executes src/; both development and deployment use the same build artifact.
  url ??= existsSync(besideModule) ? besideModule : new URL('../dist/system-agent-skill.json', import.meta.url);
  const bundle = JSON.parse(readFileSync(url, 'utf8')) as Partial<SystemAgentGuidance>;
  if (typeof bundle.version !== 'string' || typeof bundle.guidance !== 'string' || !bundle.guidance.length || bundle.guidance.length > SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS || Buffer.byteLength(JSON.stringify(bundle.guidance), 'utf8') > SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES ||
      createHash('sha256').update(bundle.guidance).digest('hex') !== bundle.sha256) {
    throw new Error('系统 Agent 的 Skill 包无效，请重新构建服务');
  }
  return bundle as SystemAgentGuidance;
}

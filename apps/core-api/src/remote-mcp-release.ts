import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const serviceVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function remoteMcpRelease(env: NodeJS.ProcessEnv = process.env) {
  const revision = env.TSP_SOURCE_REVISION?.trim().toLowerCase() ?? '';
  return { serviceVersion, sourceRevision: /^[a-f0-9]{40}$/.test(revision) ? revision : null };
}

interface ToolContract {
  name: string;
  description: string;
  schema: z.ZodType;
  annotations: object;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, sortedJson(child)]));
}

export function fingerprintRemoteMcpTools(tools: readonly ToolContract[], allowPersonalMemory: boolean): string {
  const catalog = tools.map(({ name, description, schema, annotations }) => ({
    name, description, schema: z.toJSONSchema(schema, { io: 'input' }), annotations,
  })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(sortedJson({ catalog, allowPersonalMemory }))).digest('hex');
}

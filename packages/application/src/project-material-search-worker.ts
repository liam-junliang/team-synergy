import { parentPort, workerData } from 'node:worker_threads';
import type { ProjectMaterialGrepMatch, ProjectMaterialMetadata } from '@team-synergy/contracts';

type Input = { documents: Array<{ metadata: ProjectMaterialMetadata; body: string }>; pattern: string; mode: 'literal' | 'regex';
  caseSensitive: boolean; contextLines: number; offset: number; limit: number; maxChars: number };
/** One result per matching line; no user pattern runs on the API event loop. */
export function scanMaterialText(input: Input) {
  let regex: RegExp;
  try { regex = new RegExp(input.mode === 'regex' ? input.pattern : input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), input.caseSensitive ? 'u' : 'iu'); }
  catch { return { error: 'material_invalid_regex' }; }
  const matches: ProjectMaterialGrepMatch[] = [];
  let seen = 0, outputChars = 0;
  for (const { metadata, body } of input.documents) {
    const lines = body.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const column = regex.exec(line)?.index ?? -1;
      if (column < 0) continue;
      if (seen++ < input.offset) continue;
      if (matches.length >= input.limit) return { matches, truncated: true, nextOffset: input.offset + matches.length };
      const start = Math.max(0, column - 200), text = line.slice(start, start + 1200);
      const context = lines.slice(Math.max(0, index - input.contextLines), index + input.contextLines + 1)
        .map((text, n) => ({ line: Math.max(0, index - input.contextLines) + n + 1, text: text.slice(0, 1200) }));
      const match: ProjectMaterialGrepMatch = { sourceKind: metadata.sourceKind, objectCode: metadata.objectCode, path: metadata.path,
        title: metadata.title, source: metadata.sourceCitation, sourceCitation: metadata.sourceCitation, revision: metadata.revision, revisionCode: metadata.revisionCode,
        line: index + 1, column: column + 1, text, context, textTruncated: start > 0 || text.length < line.length || context.some(row => row.text.length < (lines[row.line - 1] ?? '').length) };
      const size = JSON.stringify(match).length;
      if (outputChars + size > input.maxChars) return { matches, truncated: true, nextOffset: matches.length ? input.offset + matches.length : null };
      outputChars += size; matches.push(match);
    }
  }
  return { matches, truncated: false, nextOffset: null };
}
if (parentPort) parentPort.postMessage(scanMaterialText(workerData as Input));

// Offline declaration consistency gate. Model/route declarations are not execution proof.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const originKey = origin => JSON.stringify([origin.kind, origin.requested_model, origin.response_model]);

export function auditOrigins({ artifact, quality, execution }) {
  const issues = [], missing = [], values = {};
  const inputs = { artifact: artifact?.semantic_author?.provenance, quality: quality?.model_provenance, execution: execution?.model_provenance };
  for (const [name, value] of Object.entries(inputs)) {
    if (value == null) { missing.push(`${name}.provenance`); continue; }
    if (!keys(value, ['requested_model', 'origins', 'mixed_origins']) || !text(value.requested_model) || !Array.isArray(value.origins) || value.origins.length < 1 || typeof value.mixed_origins !== 'boolean') { issues.push(`${name}:invalid_provenance_shape`); continue; }
    let valid = true;
    for (const [index, origin] of value.origins.entries()) {
      if (!keys(origin, ['kind', 'requested_model', 'response_model', 'uses']) || !['cache', 'live'].includes(origin.kind) || !text(origin.requested_model) || !text(origin.response_model) || !Number.isSafeInteger(origin.uses) || origin.uses < 1) { issues.push(`${name}.origins[${index}]:invalid_origin_shape`); valid = false; continue; }
      if (![origin.requested_model, origin.requested_model.split('/').at(-1)].includes(origin.response_model)) { issues.push(`${name}.origins[${index}]:response_route_or_short_name_mismatch`); valid = false; }
    }
    if (!valid) continue;
    if (new Set(value.origins.map(originKey)).size !== value.origins.length) issues.push(`${name}:duplicate_origin_rows`);
    const mixed = new Set(value.origins.map(origin => origin.requested_model)).size > 1;
    if (value.mixed_origins !== mixed) issues.push(`${name}:mixed_flag_mismatch`);
    values[name] = { requested_model: value.requested_model, mixed_origins: value.mixed_origins, origins: value.origins.map(origin => ({ kind: origin.kind, requested_model: origin.requested_model, response_model: origin.response_model, uses: origin.uses })).sort((a, b) => originKey(a).localeCompare(originKey(b))) };
  }
  if (!text(artifact?.semantic_author?.model)) missing.push('artifact.semantic_author.model');
  else if (values.artifact && artifact.semantic_author.model !== values.artifact.requested_model) issues.push('artifact:current_model_and_requested_route_mismatch');
  for (const name of ['quality', 'execution']) if (values.artifact && values[name] && digest(values.artifact) !== digest(values[name])) issues.push(`${name}:provenance_differs_from_artifact`);
  if (!Array.isArray(execution?.response_models)) missing.push('execution.response_models');
  else {
    const responses = execution.response_models;
    if (responses.some(value => !text(value))) issues.push('execution:invalid_response_model_name');
    if (values.execution) {
      const declared = [...new Set(values.execution.origins.map(origin => origin.response_model))].sort();
      if (JSON.stringify([...new Set(responses)].sort()) !== JSON.stringify(declared)) issues.push('execution:response_models_do_not_equal_actual_declared_response_set');
    }
  }
  const status = issues.length ? 'fail' : missing.length ? 'unverified' : 'pass';
  const declaration = values.artifact;
  return { origin_audit_version: 1, declaration_status: status, issues, missing,
    declaration_sha256: declaration && digest(declaration), current_requested_model: declaration?.requested_model,
    origins: declaration?.origins, mixed_origins: declaration?.mixed_origins,
    declared_uses: declaration && { cache: declaration.origins.filter(origin => origin.kind === 'cache').reduce((n, origin) => n + origin.uses, 0), live: declaration.origins.filter(origin => origin.kind === 'live').reduce((n, origin) => n + origin.uses, 0) },
    execution_evidence_status: 'unverified',
    required_independent_evidence: [
      'Bind live uses to original accepted request/response audits, including exact requested route, response name and task/prompt identity.',
      'Bind cache uses to original cache-origin identities, output hashes, source snapshot/engine/policy/input and explicit legacy-origin opt-in; do not relabel historical CN responses as current SG.',
      'Reconcile per-origin uses against the actual final-run cache/live consumption ledger; original provider call counts are not segment-cache use counts.',
    ],
    limitations: [
      'Pass means the three declarations agree. It does not prove the declared routes were executed or identify provider region behind a local proxy.',
      'Full-route/short-name matching does not prove identical weights, behavior, availability or quality across routes.',
      'This separate gate does not modify or relax source/schema/citation checks or the frozen 12-question semantic benchmark.',
    ] };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Use --name value'); options[args[i].slice(2)] = args[i + 1]; }
  for (const key of ['artifact', 'quality', 'execution', 'out']) if (!options[key]) throw new Error(`Use --${key} <path>`);
  const inputs = Object.fromEntries(['artifact', 'quality', 'execution'].map(key => [key, JSON.parse(readFileSync(options[key], 'utf8'))]));
  if (['artifact', 'quality', 'execution'].some(key => path.resolve(options[key]) === path.resolve(options.out))) throw new Error('Output must not overwrite an input');
  const result = auditOrigins(inputs);
  mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true }); writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ declaration_status: result.declaration_status, execution_evidence_status: result.execution_evidence_status, out: path.resolve(options.out) }) + '\n');
  if (result.declaration_status === 'fail') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

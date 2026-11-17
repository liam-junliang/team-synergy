// Private bounded transport: no production cache, retries, failover, or inferred token counts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const CONFIG = Object.freeze({ protocol: 'module-pilot-4', endpoint: 'http://127.0.0.1:3425/v1/chat/completions',
  model: 'workbuddy/deepseek-v4.1-flash', temperature: 0, thinking: { type: 'disabled' }, reasoning_effort: 'low',
  max_tokens: 8192, timeout_ms: 60000, context_bytes: 70 * 1024, initial_calls: 16, delta_calls: 4,
  phase_limits: { task: 3, handover: 3, synthesis: 1, reviewA: 5, reviewB: 2, delta: 4 } });
export const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function transport(directory, identity, options = {}) {
  const configHash = sha(JSON.stringify({ config: CONFIG, identity }));
  const stateFile = path.join(directory, 'state.json');
  let state = fs.existsSync(stateFile) ? read(stateFile) : { configHash, calls: [], events: [], phase: 'created' };
  if (state.configHash !== configHash) throw new Error('Resume configuration/snapshot mismatch');
  const persist = () => { const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, stateFile); };
  const event = value => { state.events.push({ at: new Date().toISOString(), ...value }); state.phase = value.phase ?? state.phase; persist(); };
  persist();
  async function call({ phase, name = phase, messages, validate = value => value }) {
    const body = JSON.stringify({ model: CONFIG.model, stream: false, temperature: CONFIG.temperature,
      thinking: CONFIG.thinking, reasoning_effort: CONFIG.reasoning_effort, max_tokens: CONFIG.max_tokens,
      response_format: { type: 'json_object' }, messages });
    const requestSha = sha(body), prior = state.calls.find(row => row.requestSha === requestSha);
    const inputBytes = Buffer.byteLength(JSON.stringify(messages));
    if (prior) {
      const audit = read(path.join(directory, prior.audit));
      if (audit.configHash !== configHash || sha(fs.readFileSync(path.join(directory, audit.requestFile))) !== requestSha)
        throw new Error('Private exact-request cache identity mismatch');
      const synthesisResourceFailure = audit.phase === 'synthesis' && /^errors must be an array <= 6$/u.test(audit.failure?.message ?? '');
      const deltaResourceFailure = audit.phase === 'delta' && ['guard-affected-facts-direct', 'guard-cross-contracts-direct'].includes(audit.name)
        && audit.failure?.message === 'Invalid bounded text';
      const resourceRevalidation = options.revalidateResourceBounds === true && !prior.accepted
        && audit.accepted === false && (synthesisResourceFailure || deltaResourceFailure)
        && audit.httpStatus === 200 && audit.finishReason === 'stop'
        && audit.responseModel === CONFIG.model;
      if (!prior.accepted && !resourceRevalidation)
        throw new Error('Exact request previously failed/pending; automatic retry forbidden: ' + requestSha);
      const bytes = fs.readFileSync(path.join(directory, audit.responseFile));
      if (sha(bytes) !== audit.responseSha) throw new Error('Private response cache integrity mismatch');
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (![CONFIG.model, CONFIG.model.split('/').at(-1)].includes(envelope.model)
        || envelope.choices?.[0]?.finish_reason !== 'stop') throw new Error('Private cached response identity/finish mismatch');
      const value = validate(JSON.parse(envelope.choices[0].message.content));
      if (resourceRevalidation) {
        const receipt = 'resource-revalidation-' + requestSha + '.json';
        if (!fs.existsSync(path.join(directory, receipt))) write(path.join(directory, receipt), {
          validationRevision: deltaResourceFailure ? audit.name === 'guard-cross-contracts-direct'
            ? 'delta-contract-text-resource-4000' : 'delta-text-resource-2000' : 'contract-resource-count-24', requestSha, responseSha: audit.responseSha,
          originalAudit: prior.audit, originalFailure: audit.failure, model: envelope.model,
          semanticCoverageChecksUnchanged: true, modelOrNetworkRetry: false,
          reason: deltaResourceFailure
            ? 'Preserve the full revised fact/contract text: replace an unadvertised 700-character storage limit with bounded fact 2000/contract 4000-character limits. Current coverage/type/nonempty checks still apply; original failure audit remains immutable.'
            : 'Preserve all returned error conditions; replace an unadvertised six-item storage limit with a bounded 24-item limit. Original failure audit remains immutable.' });
        prior.accepted = true; prior.status = 'revalidated-resource-count'; prior.revalidation = receipt;
        event({ phase, kind: 'resource-response-revalidated', requestSha, receipt, newHttpRequests: 0 });
      }
      event({ phase, kind: 'private-exact-request-hit', requestSha });
      return { value, model: envelope.model, originModel: CONFIG.model, cached: true };
    }
    const delta = phase === 'delta', used = state.calls.filter(row => (row.phase === 'delta') === delta).length;
    const phaseUsed = state.calls.filter(row => row.phase === phase).length;
    if (inputBytes > CONFIG.context_bytes || used >= (delta ? CONFIG.delta_calls : CONFIG.initial_calls)
      || phaseUsed >= (CONFIG.phase_limits[phase] ?? 0)) {
      const blockedFile = 'blocked-' + requestSha + '.request.json';
      if (!fs.existsSync(path.join(directory, blockedFile))) fs.writeFileSync(path.join(directory, blockedFile), body, { flag: 'wx', mode: 0o600 });
      event({ phase, kind: 'budget-blocked', requestSha, requestFile: blockedFile, inputBytes, requestBytes: Buffer.byteLength(body), used, phaseUsed });
      throw new Error('PILOT_BUDGET_BLOCKED: context or call limit');
    }
    const stem = `${String(state.calls.length + 1).padStart(2, '0')}-${requestSha}`;
    const requestFile = stem + '.request.json', responseFile = stem + '.response.json', auditFile = stem + '.audit.json';
    fs.writeFileSync(path.join(directory, requestFile), body, { flag: 'wx', mode: 0o600 });
    const row = { phase, name, requestSha, accepted: false, status: 'pending', audit: auditFile };
    state.calls.push(row); event({ phase, kind: 'request-started', requestSha });
    const started = Date.now(), audit = { configHash, phase, name, requestSha, requestFile, responseFile,
      startedAt: new Date(started).toISOString(), inputBytes, requestBytes: Buffer.byteLength(body),
      retryCount: 0, provider: CONFIG.endpoint, requestedModel: CONFIG.model, usage: null };
    try {
      const response = await fetch(CONFIG.endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(CONFIG.timeout_ms), headers: { 'content-type': 'application/json' }, body });
      audit.httpStatus = response.status;
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.byteLength; if (length > 2 * 1024 * 1024) throw new Error('Response byte limit'); chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks); fs.writeFileSync(path.join(directory, responseFile), raw, { flag: 'wx', mode: 0o600 });
      audit.responseBytes = raw.byteLength; audit.responseSha = sha(raw);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const envelope = JSON.parse(raw.toString('utf8')), choice = envelope.choices?.[0];
      audit.responseModel = envelope.model; audit.finishReason = choice?.finish_reason; audit.usage = envelope.usage ?? null;
      if (![CONFIG.model, CONFIG.model.split('/').at(-1)].includes(envelope.model)) throw new Error('Response model identity mismatch');
      if (choice?.finish_reason !== 'stop') throw new Error('Incomplete response: ' + choice?.finish_reason);
      if (typeof choice.message?.content !== 'string') throw new Error('Missing response content');
      audit.outputBytes = Buffer.byteLength(choice.message.content);
      const value = validate(JSON.parse(choice.message.content));
      row.accepted = true; row.status = 'accepted'; audit.accepted = true;
      return { value, model: envelope.model, originModel: CONFIG.model, cached: false };
    } catch (error) {
      row.status = 'failed'; audit.accepted = false; audit.failure = { name: error.name, message: error.message,
        code: error.code ?? null, details: error.details ?? null };
      // Plain Error prevents unchanged production helpers from automatically repartitioning/retrying.
      throw new Error(error.message, { cause: error });
    } finally {
      audit.elapsedMs = Date.now() - started; audit.finishedAt = new Date().toISOString();
      write(path.join(directory, auditFile), audit); event({ phase, kind: 'request-finished', requestSha, status: row.status });
    }
  }
  return { call, event, state: () => structuredClone(state), configHash };
}

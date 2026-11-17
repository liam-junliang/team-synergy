// Test-side observation only. Request bodies and credentials are never retained.
// Optional response-loss injection consumes one real successful OV write, then
// withholds its response until the caller's original deadline actually aborts.
export function installProjectionObserver({ baseUrls, entries, context = () => ({}), save = async () => {}, injectTimeoutOnce = false }) {
  const original = globalThis.fetch, origins = new Set(baseUrls.map(value => new URL(value).origin));
  let injected = false, writes = Promise.resolve();
  const persist = () => { writes = writes.then(save); return writes; };
  const safeFailure = error => ({ name: /^[A-Za-z0-9_.]{1,80}$/u.test(error?.name ?? '') ? error.name : 'Error',
    code: /^[A-Za-z0-9_:-]{1,100}$/u.test(error?.code ?? '') ? error.code : null });
  const digest = async text => { const { createHash } = await import('node:crypto'); return createHash('sha256').update(text).digest('hex'); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!origins.has(url.origin)) return original(input, init);
    const started = performance.now(), entry = { ...context(), at: new Date().toISOString(), method: init?.method ?? 'GET',
      operation: url.pathname.replace(/\/accounts\/[^/]+\/users(?:\/[^/]+)?$/u, '/accounts/:account/users/:user') };
    if (init?.body) {
      const body = JSON.parse(init.body);
      if (typeof body.content === 'string') Object.assign(entry, { contentBytes: Buffer.byteLength(body.content), contentHash: await digest(body.content), wait: body.wait ?? null });
    }
    entries.push(entry);
    try {
      const response = await original(input, init);
      Object.assign(entry, { status: response.status, headersMs: Math.round(performance.now() - started) });
      const json = response.json.bind(response);
      response.json = async () => {
        try {
          const value = await json(); entry.bodyMs = Math.round(performance.now() - started);
          entry.envelope = { status: typeof value?.status === 'string' ? value.status : null,
            code: typeof value?.code === 'number' ? value.code : null, resultType: value?.result === null ? 'null' : typeof value?.result };
          if (typeof value?.result === 'string') { entry.resultBytes = Buffer.byteLength(value.result); entry.resultHash = await digest(value.result); }
          if (typeof value?.result?.task_id === 'string') entry.taskId = value.result.task_id;
          await persist(); return value;
        } catch (error) { entry.bodyFailure = safeFailure(error); entry.bodyMs = Math.round(performance.now() - started); await persist(); throw error; }
      };
      if (injectTimeoutOnce && !injected && entry.operation === '/api/v1/content/write' && response.ok && init?.signal) {
        injected = true; await response.json();
        entry.injection = 'real successful native write; response withheld until original request deadline'; await persist();
        await new Promise((_, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      await persist(); return response;
    } catch (error) {
      Object.assign(entry, { failure: safeFailure(error), elapsedMs: Math.round(performance.now() - started), signalAborted: Boolean(init?.signal?.aborted) });
      await persist(); throw error;
    }
  };
  return { restore() { globalThis.fetch = original; }, flushed: () => writes };
}

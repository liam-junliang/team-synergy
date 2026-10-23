// Fixture: current export implementation. This file has not been executed in this evaluation.
export async function requestExport(actor, request, store, queue) {
  if (actor.role !== 'admin') throw new Error('FORBIDDEN');
  if (request.rowCount > 10000) throw new Error('ROW_LIMIT');
  const prior = await store.findByRequestId(request.requestId);
  if (prior) return prior;
  const job = await store.insert({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    requestedBy: actor.id,
    rowCount: request.rowCount,
    state: 'queued',
  });
  await queue.publish(job);
  return job;
}

export async function completeExport(jobId, store) {
  return store.update(jobId, { state: 'ready' });
}

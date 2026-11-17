# Local memory performance baseline

Runs real, loopback-only TencentDB Agent Memory and OpenViking HTTP workloads with fresh synthetic resources. It does not migrate storage, change durability or model settings, edit upstream source, or run Agent chat inference. Existing API calls may perform Embedding and Wiki ingestion through the configured local models.

Run smoke tests first, then baseline engines **sequentially**:

```powershell
node scripts/memory-perf/run.mjs --engine tencent --profile smoke
node scripts/memory-perf/run.mjs --engine openviking --profile smoke
node scripts/memory-perf/run.mjs --engine tencent --profile baseline
node scripts/memory-perf/run.mjs --engine openviking --profile baseline
node scripts/memory-perf/run-embedding.mjs <new-synthetic-run-id>
```

Private profiles are read in memory from `TSP_PILOT_RUNTIME` (default local `F:/workspace/team-knowledge-runtime`) and `TSP_PILOT_HUB` (default `F:/workspace/team-knowledge-hub`). Do not paste credentials into CLI arguments. Resource ownership checks precede external mutations. Reports and samples are under `docs/experiments/memory-performance/<run-id>/<engine>/`.

The baseline uses 1/4/16 closed-loop clients, 48 samples per phase and two rounds. Two warmup operations are excluded per phase. This is a short, small-corpus baseline rather than a steady-state or production capacity test. p99 is exploratory at this sample size. Second-round concurrency order is reversed and corpus counts are recorded; appended vector data remains a possible confounder.

All/success/failure latency distributions are separate; throughput uses the entire measured wall window. Failed requests and timeouts are retained, and a phase deadline stops new dispatch rather than fabricating observations. Every HTTP request has a separate timeout. Index visibility probes are distinct from request acceptance and are upper-bound observations including polling and search latency.

The load generator does not retry requests. Internal engine/SDK retries remain part of the measured system and can contribute to queueing and visibility delays.

Process CPU/memory/I/O and GPU samples use Windows CIM and `nvidia-smi`. Process transfer counters include networking and pipes, so they are not disk throughput. Two-second sampling may miss very short phases. Queue observations are global/shared. Log diagnostics contain counts only; no log lines, credentials or memory bodies are exported. Shared workstation activity is an attribution limitation.

Cleanup deletes only freshly created and identity-checked benchmark resources. Tencent's append-only audit mirror may retain synthetic audit traces; it is never rewritten or truncated. API requests are simulated member streams: this is a storage/retrieval performance test, not an evaluation of Codex/dsh/OpenCode or DeepSeek reasoning quality.

OpenViking separates `contentBaselineAccepted` from `semanticBaselineAccepted`. A blocked index bootstrap does not invalidate completed, exact-readback-verified content timing samples, but it prevents a complete semantic throughput claim. `accepted=false` is retained. Manual memory files append a server-owned `MEMORY_FIELDS` trailer: body hashes and stored-envelope hashes are verified separately according to that storage contract.

`run-embedding.mjs` is an independent, serialized attribution control against the same local BGE model without memory database calls. Its native API service duration includes scheduling and is not pure GPU execution time. Do not subtract quantiles from separate requests to claim an SQL cost. `exact-input-diagnostic.mjs` checks the bounded synthetic OpenViking fixture text separately; public preset-directory input controls and failed smoke artifacts are retained in the experiment folder.

For a cold account with many newly registered members, `--index-timeout-ms 120000` extends only the index-bootstrap observation window (default 15000 ms). It does not retry writes or change measured phase sample counts, concurrency, or request timeouts. Keep censored earlier runs as separate evidence. A longer deadline is not a latency improvement and cannot establish equivalence to an earlier censored bootstrap.

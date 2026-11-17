# 双引擎修复与性能优化

日期：2026-11-11。基线与原始证据见 [72-memory-performance-baseline.md](72-memory-performance-baseline.md)。

## 本轮边界与实施顺序

1. Tencent Wiki：先用回归测试锁定正文、中文 FTS、标题/链接图谱、批量写入、删除和重新同步的行为，再把页面 API 的全量目录扫描和全表索引重建改为增量更新。保留启动、导入及外部文件变动后的完整同步路径；不能牺牲写后可检索的一致性。
2. OpenViking：先用公开的预置目录文本复现 Ollama BGE-M3 的非有限向量错误，在同模型、同维度下验证最小修复。不得伪造向量、跳过目录初始化或静默更换语义模型。修复需验证数值有效性、向量兼容性、新账号初始化和真实语义检索。
3. 部署：保留上游已有兼容补丁，记录增量补丁、构建结果、配置与回滚备份。只重启经所有权校验的本地服务，不改业务数据及无关工作区。
4. 复测：双引擎分开运行，沿用 1/4/16 并发、每轮 48 样本、两轮的既有基线。分别报告成功、失败、入队、索引完成和清理结果；不覆盖历史证据。
5. 独立复核：检查索引等价性、跨成员/项目隔离、数值修复边界及前后对照。当前没有证据支持先迁移 PostgreSQL，本轮不改持久层类型。

## 验收与风险

- 页面增量索引与完整同步结果一致，中文检索和链接图谱不回退。
- 新账号可完成目录及内容向量化，语义基线不再因预置文本数值错误阻塞。
- 性能收益以同工作负载的实测数据为准；结果不足时明确记录限制。
- 部署变化具备可复现补丁和回滚方式；不提交、不推送无关代码。

## 实施结果

### Tencent Wiki

- 上游修改限于 `MemoryKnowledge/src/engines/wiki/{manager,index-db}.ts` 与 `src/routes/wiki.ts`，保留原有三份兼容补丁。
- 页面 API 仅重读最终落盘的改动页并更新 FTS/元数据。新增派生表 `page_link`、`index_state`，保存精简的原始链接；标题、可见类型或歧义目标变化时，重新解析精简全图并仅写入边的差量。没有缓存全库正文。
- 增量写保留读连接，不再逐页主动执行 `wal_checkpoint(TRUNCATE)`；增量写连接在事务前使用 `synchronous=FULL`，保证提交同步，避免仅保留 NORMAL 而取消 checkpoint 会放宽断电持久性的变化。其余完整同步保留原有 NORMAL + TRUNCATE。WAL 自动检查点继续工作。区别参考 [SQLite 同步说明](https://sqlite.org/pragma.html#pragma_synchronous)。
- 删除可能改写入链页面，因此仍走完整同步。旧索引、非 ready 状态、启动、导入和显式外部文件同步继续使用完整重建。外部文件编辑后需要显式同步或重启。
- 索引失败时页面文件已经写入，API 返回 503，说明可重试或完整同步；不会用成功响应掩盖未可检索状态。文件和索引没有跨资源原子事务。
- FULL 约束的是 SQLite 索引提交；本轮没有增加 Markdown 文件 fsync，不能据此承诺整条 API 的断电持久性。
- 等分 FTS 和歧义链接增加确定性排序，回归验证增量与完整同步结果一致。
- Windows 用实际磁盘大小写归一页面标识，覆盖现有 `A.md` 被 `a` 更新、父目录大小写及同批新建别名；不把公开标识统一改成小写。

实现前回归 6 绿 3 红；审查后追加 Windows 和同步策略回归，最终真实 SQLite/Hono 回归 **15/15、零跳过**，TypeScript typecheck 与构建通过。可复现补丁及测试位于 `F:/workspace/team-knowledge-hub/patches/tencent-incremental-index.patch` 和 `patches/tests/tencent-wiki-incremental.test.ts`。最终补丁 SHA256 为 `d6ab18ae49ab15ae7e45f419ef999f1a275141f5efb3a70b2a371d96736be5a5`，bundle SHA256 为 `ac1f9f50481cc029ac8be7ba7dbb397fc6c2f76d1c8601da7aad4655f5118f00`。

部署脚本用临时 Git index 从已固定的 HEAD 组装审核补丁，并与实际完整 diff 比较，避免拼接 diff 的路径顺序误判；不会修改真实 Git index。仍拒绝未审核改动和未跟踪的执行源码。本轮补丁仅修改既有源码文件；回归测试另行留档。

### OpenViking 数值故障

公开预置文本直接请求 BGE-M3 即可触发 GPU NaN，不经过记忆存储。CPU 同权重路径正常；`num_batch=128/64` 无效；Ollama 0.14.2 的 OpenAI 接口未采纳透传的 `options.num_gpu`，反向控制排除了沿用已加载 CPU runner 的误判。同进程不同模型标签仍可能按权重路径复用 runner，因此没有用新标签来冒充设备隔离。

使用已有 `ollama.exe` 启动独立的 CPU 实例 `127.0.0.1:11435`，复用现有模型目录，不下载模型、不修改原模型标签或 GPU 服务；仅把 OpenViking 的 `embedding.dense.api_base` 指向 `http://127.0.0.1:11435/v1`。Tencent 继续使用 `11434` 的 GPU。CPU 启动脚本为 [memory-embedding-cpu.ps1](../scripts/memory-embedding-cpu.ps1)，使用 process 级环境变量，不修改用户/系统环境。设备选择参考 [Ollama 官方文档](https://docs.ollama.com/gpu)。

模型仍为 `bge-m3`、1024 维、manifest digest `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`、同一权重 blob。两个实例均为 Ollama 0.14.2，实际运行 context 4096；CPU 的 `/api/ps` VRAM=0，GPU 实例保持 GPU。没有改 OpenViking 上游代码、向量持久层、model name，也没有打开 metadata override。collection 兼容键不含 API base；配置指纹变化重建相应运行时资源，服务保留旧向量并通过启动兼容校验。

三段预置/合成正文经过 native/OpenAI 共六次 CPU 请求均返回有限、非零的 1024 维向量。六份中文相关/干扰材料、三个查询，两协议下 CPU/GPU 完整六项排名一致，Top1 符合预期；同正文余弦为 **0.999802–0.999994**，检索分数最大差值 **0.001786**。这支持本轮短文本兼容，不代表任意文本完全等价。证据见 [数值验证](experiments/memory-performance/20261111-perf-embedding-cpu-instance-a/validation-summary.json)。

cluster runtime 与账号 hub 没有 embedding 覆盖；本轮两个仍存活的新账号也直接 GET 到配置，确认没有账号/credential 覆盖，继承全局 CPU 路由。证据见 [账号路由检查](experiments/memory-performance/20261111-perf-embedding-cpu-instance-a/account-routing-check.json)。

### 真实验证与前后对照

OpenViking 修复后小规模 smoke：**72 个计时请求，零失败**，两成员索引、语义检索、正文回读及删除均完成。16 成员首轮仍在 15 秒索引观测截止时处于 running，保留为未通过的 `optimized-openviking-a`，没有覆盖或改判；618/618 正文核验及账号清理完成。后续 `optimized-openviking-b` 仅将初始化观测窗口延长到 120 秒，计时请求负载、并发、样本、请求超时不变；不能把放宽观测窗口当成性能提升。首个索引实际观测为约 23 秒，其余 15 个均完成。

OpenViking 正式 `optimized-openviking-b`：**54 阶段、2592 个计时请求、零失败**，内容与语义两层均通过；16 个成员的初始化完成，1303/1303 正文最终核验，两个测试账号删除任务完成并确认 404。四个可见性探针全部完成（约 659–930 ms，含轮询和查询，为上界）。原始数据与独立聚合见 [OpenViking summary](experiments/memory-performance/20261111-perf-optimized-openviking-b/openviking/summary.md)。

| OpenViking 多成员操作 | C1 p95 ms | C16 p95 ms | C1 成功 req/s | C16 成功 req/s |
| --- | ---: | ---: | ---: | ---: |
| 正文读取 | 3.319 | 20.889 | 473.683 | 930.395 |
| 延后处理写入 ACK | 24.148 | 110.324 | 60.465 | 181.443 |
| 等待索引完成的写入 | 1630.297 | 12931.223 | 0.732 | 1.489 |
| 语义 find | 132.111 | 965.760 | 8.121 | 16.831 |

后两项是首次获得有效语义基线，修复前没有成功的同类结果，不能计算提升倍数。内容 IO 的前后差异也不能单归于配置变化，重启、后台初始化及共享开发机都会影响短样本。同步索引写入仍明显偏慢：现有 `task_tracker.wait` 指数退避轮询上限 10 秒，观测到约 1.6/3.2/12.8 秒台阶；还需拆分任务终态时间与 HTTP 等待时间，才能判断队列、模型和等待器各自成本。本轮不将其归因于 SQLite。21/54 阶段没有内部资源样本、29/54 没有有效 CPU 差值，继续标记 unknown。

Tencent 正式 `optimized-tencent-a`：**144 阶段、6912 个计时请求、零失败**；四个 Wiki 和各项目 Core 活记录清理完成，两个跨语言来源探针通过。部署 patch 组合 hash 为 `f7f949a5c50380be9cfa7e929ee62a8482b6c90fe703532522040103c447c620`，运行 bundle hash 与最终构建一致。原 Core 进程未重启。见 [Tencent summary](experiments/memory-performance/20261111-perf-optimized-tencent-a/tencent/summary.md) 与 [72 组完整对照](experiments/memory-performance/optimization-comparison.json)。

| Tencent 操作 | 并发 | 原 p95 ms | 本轮 p95 ms |
| --- | ---: | ---: | ---: |
| 热点 Wiki 页面写入并索引 | 1 | 17.117 | 10.630 |
| 热点 Wiki 页面写入并索引 | 16 | 260.532 | 154.561 |
| 多项目 Wiki 页面写入并索引 | 16 | 233.727 | 147.055 |
| 热点 Wiki 原文读取 | 16 | 12.861 | 15.278 |
| 热点 Wiki 原文写入 | 16 | 67.716 | 84.180 |
| Core 读取 | 16 | 15.925 | 20.273 |
| Core Embedding 写入 | 16 | 366.452 | 628.497 |
| Core 变体检索 | 16 | 336.058 | 668.663 |

热点 Wiki 页面写入观测 p95 下降 **40.7%**，成功吞吐由 **68.255→108.572 req/s（+59.1%）**；多项目页面写入 p95 下降 **37.1%**。这是同类工作负载的复测结果，不是严格同快照的因果 A/B：手工 Wiki 种子均为 64 页，但四项目额外生成页合计从 33 变为 27，正文由 LLM 生成且 runId 字节也略有不同。旧文档中“每 Wiki 约 33 页”的统计口径已更正，原始数据未改。不能把全部百分比定量归于补丁，也不能宣称全平台加速。

Core 写入、检索以及部分未改动的读取路径本轮变慢，保留在表格和完整对照中。额外直连同一个 GPU BGE 服务、完全不经过数据库的 **576 请求零失败** 对照显示：native C1 两轮 p95 为 **158.155→81.521 ms**，C16 为 **638.084→348.817 ms**，同一次运行已有明显时间波动；后半轮接近原模型对照。该证据支持把模型链路/运行环境波动列为干扰，不能解释全部 Core 差异，也不能直接归因 Qwen、GPU 卸载、SQL 或本轮 Wiki 补丁。采样中 GPU 内存约 7932–8019 MiB，没有建立计时阶段内模型卸载的证据。见 [直连对照](experiments/memory-performance/20261111-perf-optimized-embedding-a/embedding-control/summary.md) 和 [采样说明](experiments/memory-performance/20261111-perf-optimized-embedding-a/embedding-control/residency-observation.json)。

为排除 LLM 语料生成差异，再用两份字节相同的确定性中文语料做配对机制微基准：64/256 页，各机制各规模 24 样本（2 轮×12），单页热点/四页批量各半，机制执行顺序交错，第二轮反序。共 **96 原始样本、48 对操作**，耗时 8.225 秒；最终正文 SHA、FTS、元数据、raw links、图谱和中文搜索结果完全一致。两个临时根目录已精确清理，源码 hash 前后不变。见 [受控机制数据](experiments/memory-performance/20261111-wiki-index-mechanism-controlled-a/comparison.json) 与 [独立复算结果](experiments/memory-performance/20261111-wiki-index-mechanism-controlled-a/verification.json)。

| 固定语料 | 当前 full sync p95 ms | 增量 p95 ms | 串行索引操作/秒 |
| --- | ---: | ---: | ---: |
| 64 页 | 22.441 | 7.754 | 51.384→154.255 |
| 256 页 | 108.892 | 55.963 | 10.518→19.782 |

该指标包含 manager 的索引、persist、连接和 checkpoint，排除正文写入（原始数据也另存包含正文写入的时间）；不是 SQL-only 时延或并发 HTTP 容量。它比较**当前版本 full-sync 与增量机制**，full-sync 也维护新增 compact 表，不能冒充旧版本源码的严格因果 A/B。256 页的增量成本仍明显增加，与仍需全局精简图谱解析一致，后续可针对该路径补分段计时。

最终根代理复验：**49/49 测试通过**（TeamSynergy/基准 23、部署/补丁 9、上游回归 15、机制工具 2），TypeScript typecheck/build 通过，项目 LSP 错误 0；9 份新增/变更 JavaScript 显式 ESLint 错误/警告均为 0，PowerShell 解析通过，diff 检查通过。两引擎正式请求 9504 加模型直连 576，共 **10080 个计时请求、零失败**；此前 15 秒观测截尾 run-a 仍保留未通过状态。

服务所有权、原 Core PID 保留、Tencent gateway 不变、OpenViking 配置仅变一个 API base 字段、最终源码/bundle/补丁 hash、报告 JSON 和真实凭据扫描均通过；四个本地业务/引擎健康端点为 200。见 [最终核验](experiments/memory-performance/optimization-verification.json)。没有迁移 PostgreSQL、新增依赖或改动 TeamSynergy 业务源码；Tencent 上游源码本轮有修改，OpenViking 上游源码没有修改。本轮不重跑成员 Agent/DeepSeek 推理效果评测。

### 运行与回退

CPU 实例需先于 OpenViking 启动：

```powershell
powershell -NoProfile -File scripts/memory-embedding-cpu.ps1 -Action start
powershell -NoProfile -File F:/workspace/team-knowledge-hub/scripts/deploy-openviking.ps1 -Action start
```

CPU 脚本同时支持 `status`、`stop`，会核验 PID、可执行文件、启动时间和本地监听所有权；停止不删除模型。不是开机自启动服务。

部署前备份位于私有 runtime 的 `backups/memory-opt-20261111-164438608`，包含原 OpenViking 配置与 Tencent bundle/配置；备份中的凭据不得复制到仓库。数值修复回退需先停止经校验的 OpenViking，恢复原 `ov.conf` 再启动，最后停止独立 CPU 实例；这会恢复原 GPU NaN 风险。Tencent 回退需停止 Knowledge 服务、反向应用本轮补丁并从审核清单移除该补丁、恢复旧 bundle 后再启动。新增表为派生索引元数据，不修改 Wiki 正文；旧代码完整同步可重建原有表。

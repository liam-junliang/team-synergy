# 记忆引擎性能基线与持久层决策

日期：2026-11-11（Asia/Singapore）。本轮保留现有持久层、服务进程、Embedding/LLM 配置，用真实本地 API 模拟并发成员请求流。

结论：**当前没有足够证据支持先整体迁移 PostgreSQL。优先处理 Tencent Wiki 每次页面写入的全量索引重建，以及 OpenViking 新身份初始化中的 Embedding 故障，再复测。**

## 验收范围

| 测量 | 阶段 / 计时请求 | 结果 |
| --- | --- | --- |
| Tencent Wiki / Core | 144 / 6,912 | 零请求失败，来源与隔离检查通过；4 Wiki 与 Core 活记录清理已验证 |
| OpenViking 内容读写 | 24 / 1,152 | 零请求失败；16 个真实新成员，账号/成员隔离通过，618/618 份已知正文 hash 回读通过 |
| 独立 BGE Embedding 对照 | 12 / 576 | 零请求失败；绕过两个记忆引擎与其数据库，返回向量均为 1024 维有限数值 |
| OpenViking 索引/语义检索 | 未进入有效吞吐阶段 | 索引初始化任务在 15 秒观察窗内未完成，保留 blocked/censored；不能给出语义吞吐或完成时延分位数 |

合计 8,640 个正式计时 API 样本。这里的零失败只指已执行的上述计时样本，**不包含未完成的 OpenViking 索引阶段，也不表示完整语义基线通过**。其报告保留 `accepted=false`，内容层 `contentBaselineAccepted=true`，语义层 `semanticBaselineAccepted=false`。

没有运行 Codex/dsh/OpenCode 成员推理或 DeepSeek 效果评测。Embedding 使用现有 `bge-m3`；少量 Wiki 完整 ingest 使用部署中现有 `hub-qwen2.5`。这些模型处理与纯存储操作分开记录。

## 方法与环境

- Windows 开发工作站，i5-13600KF，20 逻辑处理器，约 32 GiB 内存，RTX 4070 12 GiB；与其他桌面应用共享硬件。
- Tencent 源提交 `2002196f2d7c22ea267cfcaf67c5a6fa861df681`；OpenViking 0.5.3、提交 `178a8cdfb41b51e7d24c4bf79a13cc54981e0ee8`。
- Ollama 0.14.2，BGE 模型摘要 `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`；模型摘要在测后快照记录。
- 两个引擎与模型对照串行运行。每阶段使用 1/4/16 闭环客户端、48 个样本，排除 2 次暖机；两轮，第二轮反向执行并发档位。
- 每个端点、同一并发档位合并两轮共 96 个样本，以 nearest-rank 计算分位数；成功/失败延迟分列，吞吐按计时墙钟窗口合计计算。
- Tencent 使用 4 个独立 Wiki、每项目 16 条 Core 种子记录，共 64 条；初始手工 Wiki 页共 64 页，完整 ingest 额外生成 33 页（四个 Wiki 合计，初稿“每 Wiki 约 33 页”为统计口径误写，原始数据未改）。每个并发组外清理追加 Core 消息，恢复种子集合。请求流复用平台实际的项目服务写入身份，未伪装成 16 个设备认证主体。
- OpenViking 使用两个新命名空间和 16 个新 USER 成员，另一个命名空间用于同 user ID/URI 的隔离验证；正文约数百字节，完整原始与去合法元数据尾注后的 hash 分开核对。
- OV 内容写入测的是 `defer_processing` 的内容提交与 root Task 入队确认，包含相关文件/元数据处理；不是纯 SQL 或裸文件写入。测量处于新租户预置目录初始化背景下，未声称空闲热租户稳态性能。
- 整个数据集较小，这是短时并发基线，不是大语料或生产稳定容量测试。小样本 p99 仅供排查，不作为容量承诺。

## 关键实测

以下是各阶段 96 个原始样本的聚合。延迟包含传输、服务端处理与客户端解析/必要验证，不是数据库执行时间。不同端点的正文长度与工作量不同，不能用表格给两个产品排名。

| 操作 | C1 p95 ms | C16 p95 ms | C1 成功 req/s | C16 成功 req/s |
| --- | ---: | ---: | ---: | ---: |
| Tencent 热点项目 Core 读取 | 1.772 | 15.925 | 839.98 | 1,496.38 |
| Tencent 热点项目 Core 写入，含 Embedding | 101.450 | 366.452 | 11.24 | 56.49 |
| Tencent 热点项目 Core 变体查询 | 108.980 | 336.058 | 11.11 | 65.33 |
| BGE 原生 API，无记忆数据库 | 101.967 | 350.943 | 11.87 | 55.75 |
| Tencent 热点 Wiki 原文写入 | 7.104 | 67.716 | 201.30 | 286.23 |
| Tencent 热点 Wiki 页面写入与索引同步 | 17.117 | 260.532 | 72.91 | 68.25 |
| OpenViking 多成员内容读取 | 4.535 | 34.511 | 300.54 | 589.47 |
| OpenViking 多成员延后索引的内容写入确认 | 37.535 | 156.138 | 43.89 | 118.27 |

### Tencent Core：优先检查模型服务承载

同一模型的无数据库对照与 Core 带 Embedding 写入呈相近的时延量级与并发扩展趋势。OpenAI-float 对照在 C16 也得到 p95 359.100ms、55.24 req/s。此结果支持优先优化 Embedding 批处理、调度和复用，而不是先更换 Core SQLite。

这是独立请求分布的旁证，不能用两个 p95 相减声称算出了 SQL 成本。Core 搜索不返回逐条 channel provenance；本轮额外的跨语言、无词面重合探针命中预期消息，提供了向量链路可用性旁证。测后 `/health` 的 vectorStore/embeddingService/ftsAvailable 均为 true，能力标志不等于每条记录都已完成向量处理。

Core 混合读写分布还需分操作看：热点项目 80/20 场景中，读请求 p95 从 2.186ms 到 12.435ms，写请求从 101.416ms 到 240.212ms。混合总体 p95 不能代表读取时延；写子集每档仅 20 个样本，尾部解释有限。

### Tencent Wiki：同步全量索引是明确慢路径

热点 Wiki 页面写入的并发从 1 到 16，吞吐未增长，p95 增至约 261ms。分散到四个 Wiki 后，C16 约 75.37 req/s、p95 233.727ms，与单 Wiki 的 68.25 req/s 同量级。

源码进一步确认了具体算法：每次 `page/write` 都同步扫描整个 Wiki，清空 `wiki_fts/page_meta/graph_edge`，逐页分词、插入并重建边，随后 checkpoint/关闭连接。这不仅是数据库写入，还包括全目录文件读取和全量索引处理。

- [page/write 路由](/F:/workspace/team-knowledge-runtime/tencent/source/MemoryKnowledge/src/routes/wiki.ts:473)同步调用索引更新。
- `MemoryKnowledge/src/engines/wiki/manager.ts:971`：scan + rebuild；`:395`：全表重建；`:860`：初始化、写入与连接回收。
- `MemoryKnowledge/src/engines/wiki/index-db.ts:162`：同步事务和 checkpoint。

因此优先验证按修订增量索引、合并写入/批事务、连接复用及 checkpoint 策略，再增加分段计时。保留全量重建算法直接改用 PG，仍会重复扫描和分词。本轮不能把瓶颈单独归咎于单个 Wiki 的 SQLite 写锁。

完整 Wiki ingest 的四个项目从提交到 ready 约 85.67–91.80 秒，提交 API 本身仅约 10–41ms。该数据单独列为 LLM 加工/排队可见延迟，不混入存储写入分位数。

### OpenViking：内容层可测，初始化语义链有功能性阻塞

正式内容基线的隔离与正文回读通过。索引 bootstrap 的确认与完成不同：请求返回后，任务在观察窗结束时仍为 running，不能把 15 秒当实际完成耗时，也不能把未运行的语义查找记为成功。

独立定位发现：新账号/用户会为预置目录提交 L0/L1 向量任务，失败日志的 URI 指向这些初始化目录，不指向本轮 anchor 正文。

用源码中的公开预置 Resources 说明文本直接调用同一 BGE 服务，字符串与单元素数组均返回 **HTTP 500，NaN 导致响应 JSON 编码失败**；公开 User 说明文本在两种形式下均返回 200、有效向量。该对照没有调用记忆数据库。smoke-e 对应 anchor 的完全相同正文在六种独立模型请求形式下均返回有效向量；未声称对正式运行中的不同 anchor 作了同字节复测。

可以确定这是当前模型服务处理部分预置输入时的故障，持久层替换不能修复它。尚未确定具体数值算子，也未证明该故障是所有后台排队的唯一原因；语义吞吐仍需修复初始化链后重测。不能再沿用“None 输入”或“base64 不兼容”的早期猜想：正常 SDK mock 无 null，base64/null 编码直连也返回 200。

OpenViking 的文档索引 Embedding 并发当前按 account 限制为 1，query 会绕过这道 semaphore。以后测得写入吞吐受限时，也不能直接与 Tencent 的 L0 写入比较为数据库差异。

OpenViking 当前 local 向量主存由 native `PersistStore` 提供，底层为 LevelDB；内容层是 RAGFS 文件后端，Task/队列另有持久化实现。本文内容读写指标不能称为“OpenViking SQLite 性能”，改用 PG 也必须明确替换哪一个后端。

另观察到主测试账号删除任务生命周期约 328 秒，超过负载脚本的 120 秒观察窗，之后自然完成。源码先取消/等待相关任务，再清理向量和文件，共享取消等待预算上限为 600 秒；现有 Task 状态不能把 328 秒拆分给各步骤，更不能称作数据库删除耗时。两个账号与原删除任务终态均已核验，未重复提交 DELETE。

## PostgreSQL 决策

| 层 | 本轮决定 | 下一项验证 |
| --- | --- | --- |
| Tencent Core 记忆/向量 Store | 暂不为性能整体迁 PG | 先对 Embedding 调度/批处理做等价对照，再看真实存储分段耗时 |
| Tencent Wiki 全局元数据 | 暂不因本轮性能迁移 | 当前读取较快；未来可因统一运维需求独立做 PG adapter |
| Tencent Wiki 每实例索引 | 先改索引更新算法，暂不直接迁 PG | 增量索引与批量写入；若仍有可测数据库竞争，再做 PG 索引 adapter A/B |
| OpenViking 内容、Task/队列持久层 | 暂无直接迁移依据 | 区分内容提交、任务入队、初始化与任务排空，补热租户长时测试 |
| OpenViking 向量后端 | 语义基线受阻，不能判断 PG 性能收益 | 先修复预置输入导致的模型错误，完成可见性/检索正确性后再测 |

本轮不改持久层。后续若做 PG 对照，须保留相同正文、来源/版本规则、权限过滤、Embedding 模型与维度、持久化保证和检索算法，再比较延迟、吞吐及正确性，避免把改变算法的收益算成数据库收益。

## 证据与复现

- [Tencent 正式报告](experiments/memory-performance/20261111-perf-baseline-tencent-a/tencent/tencent.json)、[原始样本复算](experiments/memory-performance/20261111-perf-baseline-tencent-a/tencent/analysis.json)
- [OpenViking 正式分层报告](experiments/memory-performance/20261111-perf-baseline-openviking-a/openviking/openviking.json)、[内容指标复算](experiments/memory-performance/20261111-perf-baseline-openviking-a/openviking/analysis.json)、[清理终态恢复证据](experiments/memory-performance/20261111-perf-baseline-openviking-a/openviking/cleanup-recovery.json)
- [无数据库 Embedding 对照](experiments/memory-performance/20261111-perf-embedding-control-a/embedding-control/embedding-control.json)
- [公开预置文本故障复现](experiments/memory-performance/20261111-perf-embedding-control-a/embedding-control/preset-input-diagnostic.json)、[实际 anchor 正文对照](experiments/memory-performance/20261111-perf-embedding-control-a/embedding-control/exact-openviking-input.json)
- [脚本与运行说明](../scripts/memory-perf/README.md)：`run.mjs`、`run-embedding.mjs`、`analyze.mjs`。

所有结果保留成功、失败、截尾和清理证据。早期 smoke 的 query 分页上限与 MEMORY_FIELDS 正文封装假设属于基准脚本问题，已修正后才进入正式统计；不把它们算成产品性能故障。OpenViking 原始报告中超过观察窗的删除状态不覆盖，由单独终态证据补充；未重发删除、未直接递归删目录。

资源采样每两秒加采集开销一次：Tencent 115/144、OV 19/24 阶段没有内部采样，短阶段 CPU/I/O 必须记为未知。进程 transfer 计数包含网络和管道，不能称磁盘吞吐。日志是启发式计数；Tencent Core 新增日志约 23MB，只扫描末尾 4MiB，零匹配不能证明整轮无内部错误或锁等待。客户端的零请求失败以全部原始请求记录为准。

本轮新增基准工具通过 15 项单元/协议模拟测试、Node 语法检查、PowerShell 解析及显式 ESLint（零错误、零警告）。结果和建议经过独立只读复算审查。没有修改平台业务源码、两个上游仓库源码、模型配置或数据库后端。

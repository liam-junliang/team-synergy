# UA 代码理解的独立质量评估

本目录保存从固定源码建立的问题、判分约定和人工复核结果。评估对象是 **UA 生成的解释与关系**；源码是裁判依据，不把“Agent 可以继续打开源码”算成图谱已经解释正确。

`benchmark-definition.json` 在查看全仓新版结果前冻结，包含 12 个正常/被拒操作与跨层责任问题。生成端不得使用这些具体答案作为提示词。复用其他项目时，先由独立审阅者按项目的固定来源重新建立问题，不能把本项目规则套到其他系统。

每题 0–3 分：缺失/错误、仅能导航、解释具体规则与约束、能支撑上下游与验证的接手。分数由审阅者逐题读源码及实际图解释后给出。关键词、存在文件节点、覆盖率、边数和模型的自评都不能直接转换成语义分数。缺少解释与错误断言分别登记；测试定义与测试执行事实分别核对。

机械工具只负责固定来源、生成复核材料并验证裁决引用真实存在，不判断业务语义。

```powershell
node apps/core-api/tests/code-analysis-quality.mjs freeze --definition docs/experiments/code-analysis-quality/benchmark-definition.json --snapshot <snapshot.json> --source <frozen-source> --out <quality-root>
node apps/core-api/tests/code-analysis-quality.mjs inspect --benchmark <quality-root>/benchmark.json --snapshot <snapshot.json> --source <frozen-source> --graph <ua-graph.json> --review <manual-review.json> --out <quality-root>/<iteration>
```

两次命令均离线，不读取平台凭据、不连接业务数据库、不调用模型。人工裁决固定 benchmark 和 graph 的 SHA-256，引用源码范围与图中原句。新版本改换源码提交时，应单独建立新来源评估，不能以旧版本答案冒充当期真值。

验收目标在定义中预先声明：至少 27/36 分、9/12 题达到能解释具体规则的水平、受审关键问题零严重错误断言。这是这组题的验收目标，不是“理解全项目 95%”或企业级合规保证。还须单独报告全仓输入覆盖、模块归属与跨批关系的证据强度。

结构审计与最终验收记录
----------------------

`code-analysis-quality-audit.mjs` 是第二条离线检查链。显式传入最终公开 artifact、运行报告与一致性记录，避免拿中间文件事实代替用户可读的代码理解。它不读取题目答案、不修改冻结的 12 题 / 37 个源码范围、不调用模型或业务数据库。

```powershell
node apps/core-api/tests/code-analysis-quality-audit.mjs --artifact <artifact.json> --report <semantic-quality.json> --consistency <semantic-consistency.json> --snapshot <snapshot.json> --source <frozen-source> --plan <semantic-source-plan.json> --facts-directory <run-directory> --raw-briefs <semantic-file-briefs.raw.json> --briefs <semantic-file-briefs.json> --out <quality-root>/<iteration>/structural-audit.json
```

最低输入是 `artifact`、`report`、`consistency`、`snapshot` 和 `out`。缺少源码、分段计划或事实文件时，全字节输入只能标成 `unverified`，即使报告自称 100% 也不能通过。`facts-directory` 只读取该层 `semantic-file-batch-*.json`，不递归、不读取凭据、缓存、对话或其他项目。建议使用全部参数；原始及最终 brief 用于逐条 claim 清单和修订摘要核验。

脚本检查固定来源、文件节点覆盖、分段字节连续性及身份、唯一模块与 layer 归属、公开节点与关系的有效证据范围、跨批次文件依赖及对应模块投影、一致性检查的计数/claim 清单/brief 摘要，以及纠正与未知项是否进入公开图。空文件不伪造行号。结构失败返回退出码 1；证据缺少输出 `unverified`。结果永远保留独立语义评审待办，不能仅按退出码批准成果。

已知一致性协议 `cross-file-claims-1.1.0`、`1.2.0` 与 `1.3.0` 可以把新增审查理由按 claim 类别和处理结果压缩展示，不要求每条原始 reason 都进入公开图。审计会独立重算该文件完整 checks 的 SHA，并核对公开分组的 claim、处理结果、意见/不同理由数量、示例与未展开余数，以及未决依赖摘要。完整 findings 仍须保留，原有 unknown 不得压缩丢失；`corrected` 与 `uncertain` 混合意见必须保留待确认，不能因只有一个纠正文本就采纳。`report.unresolved` 到公开图的可见性检查保持不变。审计明确支持 1.0–1.3，缺失或未来未知版本按失败处理，须先审阅新协议再扩展。摘要身份和计数通过仍不代表语义正确，定义证据仍须人工逐条审阅。

1.3 允许宿主把证据不足的 `corrected` 提议降为 `uncertain`：必须是固定 `host_reason` 和公开说明、空 `replacement`，原提议只留私有 `original_proposal`。审计核对规范化字段、原提议形状/长度、ID 格式与唯一性、合法源码范围和映射一致性，校验 `host_downgraded_findings` 按审查意见计数、`applied_corrected_claims` 与实际采用的 claim 数及旧 `corrected_claims` 一致。1.3 报告必须转发两项新统计并与一致性记录精确相同。降级不能豁免身份、格式或引用错误。

提供最终 briefs 时，会核对被降级的该文件、该 claim 实际保留待确认，包含降级意见的多页结果不能被另一页纠正覆盖；对应公开审查摘要不得夹带私有提议的理由或替换文本。公开图、报告与最终 brief 携带 `original_proposal` 对象一律失败。其他节点可能独立拥有与被拒提议相同的正确事实，因此跨节点同句只登记为 potential match：`private_proposal_reuse_evidence` 标记 `unverified`，逐条核对该节点的独立来源，不能仅凭同词就认定提议被采用、删除合法事实或自动放行。规范化 sidecar 只留下 ID 和映射后范围，没有原始页完整目录，因此这些检查**不能独立证明原页目录成员关系或完整 callee 定义确已提供**；有宿主降级时单列 `host_proposal_catalog_scope` 人工门，须查看原请求页目录或独立取证，不能把 ID 格式合法当作语义证据充分。

测试运行语句的搜索仅生成**人工候选**：未命中不表示没有误读，命中也不自动断言错误。实际测试执行必须由独立运行记录证明。跨批/跨模块边数仅展示综合结构，关系是否完整、代码是否真的支持业务解释与运行影响，仍需读源码。接受的存储事实与内容 hash 证明工件身份，不能证明服务端模型实际关注或理解了每个字节。

用 [acceptance-template.md](acceptance-template.md) 记录实际发现、证据和剩余限制。先完成结构审计，再按同一冻结问题人工评分；新增发现另外登记，不改变本轮题目或门槛。

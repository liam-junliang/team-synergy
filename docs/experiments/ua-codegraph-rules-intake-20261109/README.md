# UA/codegraph 规则与需求集成试跑

日期：2026-11-09。使用已实现的 `tsp intake prepare --code-run` 和 `spec-production 2.2.0`，由当前 Agent 读取材料、查询并写作；没有另外部署模型分析服务。

## 查看效果

- [业务规则与验收矩阵](business-rules.md)：18 条规则、23 组 AC/验证计划，覆盖代码与资料生成规格的发布、停止、恢复及修订边界。
- [平台草稿](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/overview?tab=intake)：批次 `P2N0A40W9WDFP4JXWCCG`，9 项候选，其中 6 条结构化需求。已发布项为 0，尚未请求业务批准。
- [实现、命令与边界](../../62-code-rules-intake.md)。

本机用户工作空间保留 `work/ua-cg-rules-20261109` 完整候选、查询、审查和收据，以及 `work/ua-cg-rules-preview-20261109-reviewed/index.md` 的 7 篇导出文档。原首稿和首轮导出仍保留。

## 实际走通的链路

1. 固定分析 `W3Q0P72K24AE9E89P021`，代码提交 `92728fbec04cfa34fee4421cb0a9319d1b755164`；包含 638 个原始代码文件及 1 份知识文档，不混入当前未提交的集成代码。
2. 真实执行新 prepare，核对已发布知识和本机固定源码；初始知识查询返回 100/790 节点，明确标记裁剪。
3. Agent 实际执行 UA overview/search/relations 与本机 codegraph context/callers，再阅读固定源码。原生符号 ID 前缀错误及成功重查保留在日志中。
4. 生成规则文档和原有候选格式，运行 validate/export，经独立语义检查、修订和定向重查。
5. 保存平台草稿并重新读取；9 项正文及 source 与本地候选逐项相等，全部 pending，无发布计划、无已发布结果。

## 校验和复核的区别

首轮候选已经通过协议和质量校验，独立源码复核仍发现 5 处需要修订：允许跳过已映射来源；历史 running 的质量检查兼容条件；来源保护取决于已完成记录；忙异常夹具的注入时机；静态 Web 夹具无法证明真实交互。

修订同步到规则、结构化规格、AC、验证计划、矩阵和导出；补充 5 项 AC 后，共 23 组。初始 PARTIAL 报告与定向重查分别保留。独立首轮阅读 18 条规则、6 条需求及原 18 项 AC；定向重查覆盖这 5 处修订及新增 AC，没有将局部复核外推为整体准确率。

最终确定性报告为 `valid=true / protocol_valid=true / quality_valid=true`，仍有 0 blocker、2 warning、1 needs_review，原因是明确保留的 partial/unknown 覆盖。所有建议验收计划均未执行，读取的既有测试只标为 defined；实现回归测试的结果不能替代这些业务验收。

候选 SHA-256：`d69014343c1dab22b13591a405230d01c767347767b388f8918da38bbcfbea05`。

## 当前结论

第一版已将 UA 业务导航、codegraph 代码查询、原始源码证据和规则/需求交付串起来。CLI 负责固定材料和校验，Agent 负责理解与写作。自动规则通过并不能代替语义复核，也不能把当前实现认定为期望政策。本次未测量准确率、token 节约或性能收益。

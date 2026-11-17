# 原生 UA 阅读器接入

日期：2026-10-28。针对首版“代码理解”地图弱于 UA 原生页面的反馈，替换 UA 展示部分，保留平台项目、快照、权限和 codegraph 查询链路。

## 当前入口与分析版本

- [项目代码理解](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/understanding)。
- 当前分析：`W3Q0P72K24AE9E89P021`；项目视图：`A9HE4E9V18DT443HKEZV`。
- 代码快照仍是 `92728fbec04cfa34fee4421cb0a9319d1b755164`，与首版对照一致；不包含尚未提交的集成代码。
- 新分析保留原生 UA 元数据。旧分析 `E2HH7X0BWJ7ENT8R6HPE` 及原项目视图仍可读取，没有原地修改。

## 展示方式变化

首版把全图切成每页 64 个节点，并仅显示两端都在该页的连线；横向网格与整体缩放让节点难读，跨页关系也不出现在画布中。现在 UA 使用原生 Dashboard 的完整渲染边界，恢复其结构/领域视图、层级和目录下钻、邻域、搜索、筛选、导览、主题与 MiniMap。

平台外层只保留紧凑的项目版本、仓库和分析选择，以及“代码关系与证据”入口。“专注阅读”可进一步让地图占据视口。codegraph 改为独立符号搜索列表和证据侧栏，原生查询仍由 Agent 在本机 CLI 执行。

结构图与业务图按原生 UA 的方式分开展示。已发布图保留全部 2,049 个 UA 节点；结构阅读投影排除 domain/flow/step，并过滤空分层及无效导览引用；业务阅读投影保留 5 个业务域、17 个流程、74 个步骤和内部关系。结构导览显示 14 步，完整发布数据保留原有 15 步。没有为缩图删除已发布知识。

## 数据、插件与隔离

- 新增可选 `artifact.ua_graph`，白名单保留原生项目描述、语言/框架、标签、复杂度、业务规则、分层说明、多重归属、关系权重/方向及导览顺序。普通统一图和 Agent CLI 协议继续兼容。
- 新增鉴权接口 `GET /projects/:project/code-understanding/runs/:run/ua-map`。仅返回成功发布、属于该项目且当前人员获授权读取的完整 UA 图；普通关系查询的分页不再限制 UA 画布。图包不重复发送证据片段；需要时按原有节点接口查询。
- 原生元数据与统一节点、边、源码快照、行号、证据、层和导览交叉核对。适配器检查所有嵌套字符串中的完整源码、已知凭证及本机路径。未知正文扩展不进入服务端。
- 原生阅读器固定 UA `2.9.8`，来源 commit `4e6d3299017a7432da15957874992837a315c5b4`。使用现有安装依赖在影子目录构建，不修改已固定的引擎目录，也没有新增平台包依赖。
- 阅读器运行于 `sandbox="allow-scripts"` 的独立 iframe；不赋予同源访问，不传递平台凭据，不允许直接网络连接。父页面按 iframe window、opaque origin、随机 channel 和当前图内节点身份验证消息。
- 原生“打开代码”转为平台的有限证据入口，完整源码仍留在本机。下载入口、独立 token gate、原始 JSON/源码加载和持久浏览器存储已关闭。
- 预构建资源、内容摘要、适配源码摘要、上游版本及第三方许可证保存在 `apps/web/public/vendor/ua-reader/2.9.8/`。UA 为 MIT；ELK 的 EPL-2.0 及 ISC 等通知分别保留。

重新构建阅读器：

```powershell
node scripts/build-ua-reader.mjs --source F:/workspace/team-synergy-labs/code-understanding-20261027/understand-anything-tool
```

更换上游版本必须显式适配、构建和回归，不能直接覆盖现有 runtime。上游补丁位置不匹配时构建失败。

## 验证

- Web 全套测试 368/368、全仓 9 包类型检查通过；原生地图相关 Web 专项 12/12。最新选择同步修正后再次执行专项测试。
- 原生元数据、完整地图、权限及 HTTP/数据库专项 14/14；包括 251 个节点的跨页边与反向/双向关系。
- 原生资源摘要、适配源码匹配及许可证/无网络加载器检查 2/2；最终 Web 专项连同资源检查共 14/14。
- 真实 UA/codegraph 引擎测试 2/2，通过元数据保留、嵌套敏感/源码正文拒绝、调用者查询及原索引不变验证。
- 源码和 service 构建通过；全仓 lint 零错误、70 个已有警告。
- 浏览器实测原生结构/领域切换、业务域和流程、业务规则、步骤行号、“打开代码”到平台证据、UA 文件到 codegraph `loginWithPassword`、导览开始与下一步、专注阅读。验收标签页无 error 日志。
- 从领域视图启动导览时先切回结构图，已在浏览器验证；同节点同步不会重复添加面包屑。原页面已切到新分析，并保留此前选中的 Dockerfile `build` 节点。
- 视觉对照记录：`.omx/state/ua-native-reader/ralph-progress.json`；实际截图：`tmp/ua-native-reader-after.jpg`。
- service 最终 Web 构建与 readiness 检查通过；46 个实现/资源文件的源码与 runtime 摘要一致。原页面实际截图：`tmp/ua-native-reader-platform.jpg`。

## 实际边界

这是接入原生阅读器，不是把原生本机 Web 服务暴露给其他用户。历史缺少原生元数据的分析明确显示兼容视图；需要由 Agent 新发布分析才能获得完整体验。多仓项目按固定视图提供仓库切换，各仓独立阅读，不伪造跨仓关系。

结构搜索与业务地图使用上游原有的数据范围；业务流程通过领域视图进入。原生完整源码、远程聊天、wiki、Diff 和下载不属于本次接入范围。需求知识文档导出继续可用，原生代码知识来源与完整需求生成替换仍按后续 K6 推进。

## 主要改动

| 范围 | 文件 |
| --- | --- |
| 平台页面与数据桥 | `apps/web/src/CodeUnderstandingWorkbench.tsx`、`UaNativeReader.tsx`、`uaReaderBridge.ts`、`codeUnderstandingApi.ts` |
| 原生适配源码与构建 | `apps/web/ua-reader/*`、`scripts/build-ua-reader.mjs` |
| 版本化阅读器资源与许可证 | `apps/web/public/vendor/ua-reader/2.9.8/*` |
| 原生元数据及验证 | `packages/contracts/src/code-understanding.ts`、`apps/cli/src/code-understanding-plugins.ts` |
| 完整 UA 图鉴权读取 | `packages/application/src/code-understanding-use-cases.ts`、`apps/core-api/src/routes/code-understanding.ts` |

移除了 UA 默认分页网格、画布下方的大段导览和重复顶部信息；导览与信息面板交给原生阅读器。保留小型 SVG 仅用于旧分析的兼容展示。

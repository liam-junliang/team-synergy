# ADR-0013：draw.io 使用独立 origin 与受控消息桥

- 状态：Accepted
- 日期：2026-10-23
- superseded_by: null

## 背景

draw.io 编辑器加载于固定的 `https://embed.diagrams.net`，属于应用之外的独立 origin。`allow-scripts allow-same-origin` 组合在同源 iframe 中可能破坏 sandbox；在当前独立 origin 中，`allow-same-origin` 保留的是 diagrams.net 的 origin，并不授予应用 origin 或父页面存储权限。不能把同源 iframe 的结论直接套用到这个集成。

## 决策

- 保持固定 HTTPS 外部地址，不提供用户可配置 origin，不把编辑器反向代理成应用同源地址。若未来改变托管方式，必须重新评审隔离边界。
- 保留 `allow-scripts allow-same-origin allow-downloads` 和 `no-referrer`；不允许弹窗、顶层导航、同源 srcdoc 或用户 HTML 注入。
- 发往编辑器的消息固定 targetOrigin；接收必须同时匹配精确 origin 与该 iframe 的 Window，再校验事件名称、所消费字段的类型和字节数。编辑器附加的未消费元数据可忽略，不让未来的扩展字段破坏兼容。
- 仅处理 configure/init/load/save/export/exit。导出必须回显本次 host 发出的 action、format、requestId 与 XML；过期或来自另一 iframe 的结果不得附着到新版本。SVG 继续经过现有隔离图片数据通道，失败保留图源恢复能力。
- 编辑中的 XML 会发往该外部服务；本次加固不把第三方编辑器变成自托管或离线处理。

## 验证与限制

`apps/web/tests/diagram-rendering.test.mjs` 覆盖固定 URL、错误 origin/source、错误类型、过大和多字节图源、事件序列、保存/退出、串行与过期导出、只读和销毁行为。

`apps/web/tests/drawio-isolation.test.mjs` 使用已有 Chromium 和本地不同 host 的 fixture，验证相同 sandbox 权限下子页面无法读取父 localStorage/cookie 或移除 sandbox；子页面仍能使用自己的 origin 存储。测试不下载浏览器、不调用外部服务；无现有 Chromium 的环境显式跳过，可设置 `TSP_TEST_BROWSER_BIN` 指定现有浏览器。

2026-10-23 本机实际通过该浏览器测试；协议回归 19 项通过。此证据覆盖浏览器同源策略及本地协议适配，不声称已验证线上 diagrams.net 当前版本的完整 UI 或外部网络可用性。

参考：[draw.io 官方嵌入协议](https://www.drawio.com/docs/reference/embed-mode/)、[draw.io 官方集成安全说明](https://github.com/jgraph/drawio/wiki/Security)。

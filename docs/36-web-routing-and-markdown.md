# Web 路由与 Markdown 渲染

## 页面地址

Web 使用浏览器 History API：`/teams`、`/account`、`/projects/:code/:section`。菜单和分享链接统一由 `apps/web/src/workspaceRouting.ts` 生成；程序导航调用 `navigateWorkspace`，不再给 `window.location.hash` 赋值。

- 原 `/#/projects/...` 链接在应用加载时以 `replaceState` 转成普通路径，保留查询参数，不额外增加历史记录。
- 页面内导航使用 `pushState`，浏览器前进、后退由 `popstate` 同步页面。
- 普通文内 `#标题` 与脚注保留为片段；外站、下载、新标签及带修饰键的点击由浏览器处理。
- 登录或强制改密后保留原项目深链接；站点根入口按账号角色进入团队或账号管理。

导航逻辑集中在 `apps/web/src/workspaceNavigation.ts`，没有新增路由依赖。

## 页面服务与 API

页面 `/projects/...` 与接口路径必须区分。Web 的 JSON 请求和文件下载统一从站点根 `/api/...` 发出；代理移除 `/api` 后转给原 core-api。CLI 继续直接访问 core-api 原有路径，无需改变配置。

开发与本地构建预览由 Vite 的 SPA 回退处理路径直达；`server.proxy` 配置由预览服务继承。上游仍由 `ACP_CORE_API_URL` 指定，默认 `http://127.0.0.1:8080`。

生产静态站点需同时部署：

1. `/api/` 转发到 core-api，并剥离这个前缀。
2. 页面路径找不到静态文件时回退到 `index.html`。
3. `/assets/` 资源缺失返回 404，API 的错误状态和 JSON 原样透传。

[Nginx 配置示例](../apps/web/nginx.conf)包含这些规则。部署时修改域名、静态文件目录和上游地址；它是配置模板，本地未启动 Nginx 验证。不要只上传 `dist` 到不支持路径回退的文件服务器。

## 共享 Markdown

项目首页、文档库当前版本及历史正文、需求文档、设计资料说明、任务详情和交接正文复用 `apps/web/src/MarkdownDocument.tsx`，使用 [react-markdown](https://github.com/remarkjs/react-markdown) 与 [remark-gfm](https://github.com/remarkjs/remark-gfm)。删除旧的逐行正则渲染器；原工作台导出仅保留兼容入口。需求页和任务详情按需加载，Markdown 解析代码不进入登录页主包。

支持标准段落、H1–H6、嵌套列表、引用、链接、图片、代码块，以及 GFM 表格、只读任务清单、删除线、自动链接和脚注。代码块保留语言类，当前不提供语法高亮。原生 HTML 作为文本显示，保留库的默认 URL 过滤，不执行文档脚本。

自定义视觉样式统一修改 `apps/web/src/index.css` 中 `.markdown-document` 作用域：正文 14/24px，H1 24/32px、H2 20/28px、H3 16/24px；H4–H6 14/20px。表格与代码块局部横向滚动，图片按容器缩放，链接提供可见键盘焦点，不使用强制覆盖字号。

标题 ID 支持中文、重复标题和已有文档 outline；使用解析后的真实标题与源位置匹配，围栏代码里的伪标题不会错占锚点。文内跳转在当前文档内定位并聚焦，避免首页多份文档同名标题互相干扰。登录后或异步正文首次就绪时恢复 URL 里的片段目标；恢复成功后不会因后台正文更新反复拉回。

## 验证范围

- Markdown SSR 回归覆盖结构、GFM、安全默认值、兼容锚点及片段历史记录。
- 路由测试覆盖路径/查询参数编码、旧链接迁移、前进后退、分享、登录返回及点击边界。
- 隔离 HTTP 测试通过实际 Vite 开发/预览中间件检验页面回退和 `/api` 转发，使用临时页面与模拟上游，不访问业务数据库。
- 浏览器保存的权限设置仍阻止实际页面验证，未以 SSR 或服务测试替代视觉、键盘及真实浏览器交互验收。

2026-10-16 验证：Web 129/129 测试通过，其中 Markdown 21 项；typecheck、生产构建通过，lint 0 错误、60 条现有警告。运行中 Web 的 `/api/health` 返回 200 JSON，未携带凭据的 `/api/auth/whoami` 返回 401 JSON。

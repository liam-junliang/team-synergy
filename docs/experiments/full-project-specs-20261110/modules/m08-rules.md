# M08 项目资料与设计资产：当前代码逆向需求与业务规则

原生 DOC/API/DIAGRAM 及兼容用途文档、固定目录、业务资料关联视图、架构和原型。项目首页条目由 M03 提供，本章不重复创建首页 Feature/REQ；需求审阅与测试资料的原始业务分别归其他章节。

## 来源与事实级别

run NSG3TKRB16Y9F6Y203WB；snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；显式工作区草稿，基底提交 92728fbec04cfa34fee4421cb0a9319d1b755164。原始源码 manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；图 artifact SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8。UA 2.9.8 与 codegraph 1.6.2 为导航，Skill 2.2.0 提供逆向方法；事实证据均回查同一 snapshot 的原始文件。图谱解释仍为 inferred。

源码证据为 observed_in_code，只证明当前实现；未获业务批准。docs/experiments 只作全局比较材料，不作为本章新增业务能力的语义权威。

## 能力目录

- REQ-INT-M08-01：按原始权限统一查询项目文档库
- REQ-INT-M08-02：保护固定目录并管理普通目录树
- REQ-INT-M08-03：创建、批量上传与修订原生文档并保留历史
- REQ-INT-M08-04：对可读取资料的明确版本生成质量报告
- REQ-INT-M08-05：保存多格式架构图并强制版本冲突检查
- REQ-INT-M08-06：创建与查看多形式设计原型
- REQ-INT-M08-07：修订原型、替换关联并保留版本
- REQ-INT-M08-08：按权限下载明确版本的原型附件

## 业务规则表

|规则|触发与资格条件|结果/排序/执行约束|例外和保留事项|原始证据|测试断言|
|---|---|---|---|---|---|
|BR-INT-M08-01|当前项目有效成员；GET 项目 handoff / docs list、search、show；存在项目及有效成员关系；查询本身不授予写权限。|BR-INT-M08-01：库展示业务资料原始版本，原始资料变化在关联读取时体现，不复制成第二份可编辑正文。；BR-INT-M08-01：source_can_edit 是原始入口提示，通用 can_edit 对关联视图保持 false。；状态：普通读取不增加文档版本；历史项目可能幂等创建缺少的系统目录。|无项目访问权→拒绝读取，不通过关联资料绕过原始领域权限。；对关联视图调用通用修订→返回 source_read_only，转原始业务入口。|packages/application/src/project-document-use-cases.ts:193–250 @ bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317；packages/application/src/project-document-use-cases.ts:428–510 @ bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317；apps/core-api/src/routes/project-documents.ts:25–39 @ 3aabba47643c6b67394e44fdae802115bf7a72626856010ec3007e7ada6b38b7；packages/application/src/requirement-document-use-cases.ts:121–123 @ 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac；packages/application/src/requirement-document-use-cases.ts:384–404 @ 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac；packages/application/src/project-document-use-cases.ts:529–538 @ bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317|REQ-INT-M08-01-AC01：同项目需求文档更新后，库关联条目返回相同原始代码和当前版本且不可通用编辑。；REQ-INT-M08-01-AC02：Viewer 可按其项目读取范围查看；无关用户不能借公开代码读取资料。|
|BR-INT-M08-02|非 Viewer 的目录创建者或项目管理者；folder-create / folder-update 及目录 API；项目可写；管理者包含有效 Owner/Admin，不能仅按错误文字解释为 Owner。|BR-INT-M08-02：固定项目资料及项目说明/规范/需求/架构/测试目录依 system_role 标识，不按显示名把普通目录静默收编。；BR-INT-M08-02：普通目录创建检查同级大小写无关重名；更新路径未见同等重名复查，不能承诺所有重命名唯一。；状态：允许更新改变普通目录父节点、名称、顺序/状态；拒绝不改变树。|系统目录更名、移动或归档→拒绝；同名历史普通根目录保留独立身份。；移动到自身/后代或系统目录下→拒绝，原树不变。|packages/application/src/project-document-use-cases.ts:252–355 @ bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317；packages/application/src/project-document-folders.ts:1–77 @ c50e6f6a5c975a8ef69e9f9bbb981177d8ff038d46f3fc54a778b92c5be5974b|REQ-INT-M08-02-AC01：普通目录不能移到后代，固定系统目录不能更名。；REQ-INT-M08-02-AC02：系统目录补齐不吞并同名普通内容。|
|BR-INT-M08-03|创建/上传：当前非Viewer可写成员；修订：当前仍可写的原作者或项目管理者；docs create/upload/revise；原生文档 POST/PATCH；项目 active 且当前 write 授权有效；普通目录或允许写的 standards/overview 系统祖先。|BR-INT-M08-03：标题、正文及修订说明不能为空；CRLF 归一为 LF。；BR-INT-M08-03：普通修订允许可选 base_revision；客户端只有实际发送它才获得旧版本冲突保护。；BR-INT-M08-03：CLI upload是本地规划加多次独立创建，先目录后文档；只对每个成功的服务端创建分别保存Revision1/历史/审计，不承诺整批全有全无。；BR-INT-M08-03：根链接拒绝，嵌套链接和隐藏/忽略目录跳过；只接收.md/.markdown/.txt普通文件。auto优先api再diagram再doc，显式kind可覆盖，title/summary覆盖限单文件。；BR-INT-M08-03：失败后的恢复需先查询远端已创建对象并核对内容/代码，再对缺失文件选择已有父目录单独上传；盲目重跑目录不是resume，可能遇同级目录重名或制造重复文档。该操作建议不是已实现自动恢复能力。；状态：创建 revision=1；成功修订revision+1；可显式移动目录/变更用途及状态，省略字段沿用当前。；CLI后项失败时，之前已成功创建的目录/文档继续存在，当前失败项是否有远端副作用取决于失败发生位置；本地错误不是远端整批事务回滚。|显式 base_revision 无效或过期→拒绝，不覆盖新正文。；省略 base_revision→按锁定当前头递增，并不提供基于旧正文的乐观并发保护。；非作者普通 Member、Viewer或只读系统领域→拒绝写；文档详情可按原始读权查看。；根符号链接、不支持的单文件后缀、无效显式kind或本地规划读取失败→在远端创建循环前报错并非零退出；嵌套链接与不支持的目录内文件则被跳过。此结论只适用于这些规划前错误，不扩展为所有上传错误无副作用。；先前目录/文档已创建后，后续请求、响应缺code或再次读取本地正文失败→catch输出失败并非零退出，停止后续创建；没有回滚先前成功对象，也不输出成功分支的完整批次清单。客户端未提供幂等key、覆盖、去重或自动断点续传。|packages/application/src/project-document-use-cases.ts:357–417 @ bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317；packages/application/src/project-document-use-cases.ts:517–600 @ bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317；packages/application/src/project-document-kinds.ts:1–13 @ 4f79035e0f983c427502bca96e47455410b74ff198e6c6271833dd0b3b296421；apps/core-api/src/routes/project-documents.ts:70–112 @ 3aabba47643c6b67394e44fdae802115bf7a72626856010ec3007e7ada6b38b7；apps/core-api/src/server.ts:65–70 @ 3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada；apps/cli/src/handoff-upload.ts:29–74 @ 1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f；apps/cli/src/handoff-upload.ts:84–122 @ 1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f；apps/cli/src/index.ts:2089–2113 @ ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b；apps/cli/src/index.ts:2115–2181 @ ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b|REQ-INT-M08-03-AC01：旧 base_revision 修订不覆盖较新正文且不增加历史。；REQ-INT-M08-03-AC02：省略 base_revision 使用当前锁定版本追加。；REQ-INT-M08-03-AC03：目录上传保留层级，过滤非支持文件/隐藏忽略目录和嵌套链接，并先建目录再逐篇创建。；REQ-INT-M08-03-AC04：目录上传的确定性后项失败保留先前成功；查询后只补缺失文件，不能把全量重跑视为续传。；REQ-INT-M08-03-AC05：单文件可覆盖标题/摘要/类型且不新建目录；规划前根链接或不支持后缀拒绝不发送创建请求。|
|BR-INT-M08-04|可读取目标资料的用户；GET /handoff-documents/:code/quality；目标及指定版本可访问；purpose 属于支持集合。|BR-INT-M08-04：质量报告是规则检查结果，不等同业务通过或文档自动修改。；BR-INT-M08-04：指定版本必须为正整数；报告依据准确来源版本，不隐式写新修订。；状态：仅生成报告，无文档业务状态变化。|版本不存在/重复或无正文→返回明确 unavailable/not_found，不以当前正文冒充指定历史。；历史需求版本、非 Markdown 测试附件等来源受限→在报告保留无法检查的说明；不伪造源文本。|apps/core-api/src/routes/document-quality.ts:40–150 @ 639c56c926264bae76559379fc81e16d28298b2d913e99672ca2aa1ec6b64080|REQ-INT-M08-04-AC01：合法指定历史原生版本得到该版本摘要而不是当前文本摘要。；REQ-INT-M08-04-AC02：请求不存在的版本返回失败且不退回最新。|
|BR-INT-M08-05|创建：当前有项目write权限的成员；修订：仍有write权限的架构负责人或有效项目管理者；architecture list/show/create/revise；架构资料 API；读取需当前有效项目读权；创建需active项目与当前write权限，不另要求Owner/管理者；修订还需当前负责人或isProjectManager(Owner/Admin)。|BR-INT-M08-05：创建对当前可写成员开放；修订须当前write加负责人/管理者资格，并始终显式base_revision CAS。；BR-INT-M08-05：draw.io仅筛查mxfile/mxGraphModel根、尾部闭合或自闭合及无DOCTYPE/ENTITY；SVG预览同样为根/尾标签浅层筛查，不证明完整XML良构、渲染正确或安全。；BR-INT-M08-05：image仅接受实现所检PNG/JPEG/WebP Base64与字节特征；图源6MiB、预览2MiB，HTTP POST/PATCH整体24MiB。；状态：新增不可变架构revision并推进current_revision；图源改变时未提供的旧预览失效。|旧 base_revision→拒绝，原图和历史不变。；图源超6MiB、含NUL、不符合XML根/尾标签与DOCTYPE/ENTITY筛查、图片字节格式不符或预览超2MiB→拒绝对应字段；图源变化且不传新预览时清空旧预览。XML筛查不是完整良构解析。|packages/application/src/architecture-document-use-cases.ts:1–169 @ 07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592；packages/application/src/architecture-document-content.ts:17–77 @ 4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7；apps/core-api/src/routes/architecture-documents.ts:29–61 @ b0f0f242be538b736062a0bbee54d176696dfab62c584b4f79c5eb0a370f1ec7；apps/cli/src/architecture.ts:59–129 @ cfc4b616096a64947e4d0d1271271d5505aca92e0cd6d75b31173c238cf869a8；packages/application/src/architecture-document-use-cases.ts:103–129 @ 07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592；packages/application/src/architecture-document-content.ts:25–33 @ 4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7|REQ-INT-M08-05-AC01：旧架构版本不能覆盖当前图源。；REQ-INT-M08-05-AC02：图源变化而未传preview时删除过时预览。；REQ-INT-M08-05-AC03：普通可写Member可创建架构，但不能据成员身份修订他人的架构。；REQ-INT-M08-05-AC04：XML筛查拒绝明确禁用声明，但不能保证拒绝所有畸形XML。|
|BR-INT-M08-06|可写项目成员；读取者为项目有效成员；design list/show/create 与原型API；项目active时写；标题非空，输入类型合法。|BR-INT-M08-06：html/image正文长度最多6MiB字符；附件最多20MiB解码字节、规范Base64，保存大小和SHA-256。；BR-INT-M08-06：URL仅HTTP/HTTPS且无用户名密码；file名称不能含路径、Windows保留名等危险字符。；状态：创建draft或ready及revision1；失败不创建原型。|跨项目需求或不一致父关系→拒绝整次创建。；不安全URL、无效Base64、危险文件名、超限文件→拒绝；创建不允许archived初始状态。|packages/application/src/design-prototype-use-cases.ts:38–215 @ 8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c；packages/application/src/design-prototype-content.ts:28–109 @ c9e4c42338cfe3402d9fddc080d917fe06817cb3809906677cc23061aca2a2d1；apps/core-api/src/routes/design-prototypes.ts:33–65 @ 26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f|REQ-INT-M08-06-AC01：合法附件创建后详情只有元数据，下载入口才提供字节。；REQ-INT-M08-06-AC02：跨项目需求绑定与含凭据URL均不能创建。|
|BR-INT-M08-07|原型负责人或有效项目管理者；design revise / PATCH prototype；当前write授权有效且原型未archived；标题与change_summary非空。|BR-INT-M08-07：省略notes可保留原说明，但省略requirement_codes会清空全部需求关联。；BR-INT-M08-07：当前修订没有与架构一致的显式乐观锁契约，不能将所有版本资产描述成同一种并发语义。；状态：成功current_revision+1；关联集替换；可转archived后禁止继续修订。|已归档或无写权→拒绝。；并发修订→此路径没有base_revision或锁头CAS，不保证旧客户端的覆盖冲突被友好检测。|packages/application/src/design-prototype-use-cases.ts:321–405 @ 8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c；apps/core-api/src/routes/design-prototypes.ts:84–101 @ 26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f|REQ-INT-M08-07-AC01：省略关联字段会清空已有绑定，旧修订仍可读。；REQ-INT-M08-07-AC02：归档原型不能再修订。|
|BR-INT-M08-08|可读取原型的当前用户；design download / GET prototype file?revision；目标版本存在且为file内容；按原型所属项目读取鉴权。|BR-INT-M08-08：下载响应固定application/octet-stream、attachment、nosniff、private/no-store。；状态：无业务状态或版本变化。|版本不是正整数、不存在或非file→返回业务错误，无其他版本替代。；无身份/无项目访问→拒绝，不发送字节。|apps/core-api/src/routes/design-prototypes.ts:67–82 @ 26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f；packages/application/src/design-prototype-use-cases.ts:408–435 @ 8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c|REQ-INT-M08-08-AC01：历史附件下载保持原字节与安全头。；REQ-INT-M08-08-AC02：无关用户不能凭附件代码下载。|

## BR → REQ / AC / 验证矩阵

|BR|REQ|Feature|AC|计划状态|
|---|---|---|---|---|
|BR-INT-M08-01|REQ-INT-M08-01|tsp-feature-document-library|REQ-INT-M08-01-AC01|not_run，未来计划|
|BR-INT-M08-01|REQ-INT-M08-01|tsp-feature-document-library|REQ-INT-M08-01-AC02|not_run，未来计划|
|BR-INT-M08-02|REQ-INT-M08-02|tsp-feature-document-library|REQ-INT-M08-02-AC01|not_run，未来计划|
|BR-INT-M08-02|REQ-INT-M08-02|tsp-feature-document-library|REQ-INT-M08-02-AC02|not_run，未来计划|
|BR-INT-M08-03|REQ-INT-M08-03|tsp-feature-document-library|REQ-INT-M08-03-AC01|not_run，未来计划|
|BR-INT-M08-03|REQ-INT-M08-03|tsp-feature-document-library|REQ-INT-M08-03-AC02|not_run，未来计划|
|BR-INT-M08-03|REQ-INT-M08-03|tsp-feature-document-library|REQ-INT-M08-03-AC03|not_run，未来计划|
|BR-INT-M08-03|REQ-INT-M08-03|tsp-feature-document-library|REQ-INT-M08-03-AC04|not_run，未来计划|
|BR-INT-M08-03|REQ-INT-M08-03|tsp-feature-document-library|REQ-INT-M08-03-AC05|not_run，未来计划|
|BR-INT-M08-04|REQ-INT-M08-04|tsp-feature-document-library|REQ-INT-M08-04-AC01|not_run，未来计划|
|BR-INT-M08-04|REQ-INT-M08-04|tsp-feature-document-library|REQ-INT-M08-04-AC02|not_run，未来计划|
|BR-INT-M08-05|REQ-INT-M08-05|INT-FEAT-M08-architecture|REQ-INT-M08-05-AC01|not_run，未来计划|
|BR-INT-M08-05|REQ-INT-M08-05|INT-FEAT-M08-architecture|REQ-INT-M08-05-AC02|not_run，未来计划|
|BR-INT-M08-05|REQ-INT-M08-05|INT-FEAT-M08-architecture|REQ-INT-M08-05-AC03|not_run，未来计划|
|BR-INT-M08-05|REQ-INT-M08-05|INT-FEAT-M08-architecture|REQ-INT-M08-05-AC04|not_run，未来计划|
|BR-INT-M08-06|REQ-INT-M08-06|INT-FEAT-M08-prototype|REQ-INT-M08-06-AC01|not_run，未来计划|
|BR-INT-M08-06|REQ-INT-M08-06|INT-FEAT-M08-prototype|REQ-INT-M08-06-AC02|not_run，未来计划|
|BR-INT-M08-07|REQ-INT-M08-07|INT-FEAT-M08-prototype|REQ-INT-M08-07-AC01|not_run，未来计划|
|BR-INT-M08-07|REQ-INT-M08-07|INT-FEAT-M08-prototype|REQ-INT-M08-07-AC02|not_run，未来计划|
|BR-INT-M08-08|REQ-INT-M08-08|INT-FEAT-M08-prototype|REQ-INT-M08-08-AC01|not_run，未来计划|
|BR-INT-M08-08|REQ-INT-M08-08|INT-FEAT-M08-prototype|REQ-INT-M08-08-AC02|not_run，未来计划|

详细结构化REQ/AC/计划在同模块需求条目与本地章节；均未执行，不构成批准或安全证明。

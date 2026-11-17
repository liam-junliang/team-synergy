# Intelligence 最终定向文档修复

修前part：`0c9290779e9022d50b8110a31de6ea908dda78376271ad4d5464ddb228653aef`，保留于parts/intelligence.pre-final-repairs.json；修后part：`6a970871bbfeb325a6bf4798800b99e139f0bd61068eaf221a7c125849376ee2`。

|来源finding|修复范围|具体调整|执行边界|
|---|---|---|---|
|INT-RECHECK-001（原009残留）|REQ-INT-M14-04-AC05、REQ正文与M14章节|UA原生及投影summary同时修改；先断言schema成功与validateCodeArtifact空issues，再断言publish精确complete-source错误。|只修未来计划，未创建夹具、未发布测试artifact。|
|Shared initial finding3|REQ-INT-M08-03、capability、M08规则/AC矩阵|补递归层级、支持后缀/链接/忽略规则、推断/覆盖、先目录后文档、多请求部分成功与查询后手工补传；追加AC03–05。|3计划not_run，故障代理/链接夹具尚未建设；不承诺整批事务、幂等或自动续传。|
|Shared initial finding4|REQ-INT-M08-01-AC01、REQ正文与M08章节|明确Member A为原需求owner、有当前write/有效普通session、项目/D均active，记录r再修订r+1；通用编辑断言精确project_document_source_read_only。|未执行业务修订/API；root复制示例和总矩阵需随最终合并重生。|

保留43REQ/Feature/module/document/43capability身份及97原AC；仅追加3个AC/计划，共100AC/100计划。初稿与初审/复核报告保持原样。源码、pack、其他lane不改。M08/M14结构化spec、REQ正文、持久规则文档及本地章节同步；M11/M12/M13没有改动。

固定source的引用摘要/行界与严格schema/同步校验由validate-intelligence.mjs重新检查，输出另存review/intelligence-final-static-validation.json。静态校验不是应用测试或业务验收。

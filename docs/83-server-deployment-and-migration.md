# 容器部署、双节点运行与迁移

版本：1.0，2026-11-17。对应平台需求 `1XKF1JZKCJT1QVCH2JDT`、冻结基线 `YH31YTYE1Z4F86WK3WVH`、阶段一任务 `3X5ZJ97924MHRB27H08N`。

## 当前交付边界

阶段一提供 API、静态 Web、PostgreSQL 16 的镜像与 Linux Compose、隔离烟测、可信 CI 发布及受控更新脚本。镜像构建、服务器运行、业务数据恢复、双引擎接通、模型登录和用户切换分别验收。构建成功不表示原有数据或记忆已经迁移。

两台目标机器均约 2 核／2GB 内存／40GB 磁盘。GitHub 托管 runner 完成构建，服务器只拉取或导入镜像；不在运行服务器编译，也不在公共仓库配置生产服务器自托管 Actions runner。两台间使用私网，跨机端口需实际核验并只允许对端；应用、数据库、引擎和模型管理入口不直接暴露公网。

阶段二再固定 Tencent 兼容补丁和 Linux 运行时、迁移完整数据、验证模型容量及逐项恢复业务能力。当前代码分析仍保持暂停，已完成成果必须保留。

## 容器和持久化

| 服务 | 运行方式与数据 |
| --- | --- |
| `db` | PostgreSQL 16，命名卷 `pg-data`，监听 `127.0.0.1:15432`；更新不会删卷。 |
| `migrate` | 同一 API 镜像的独立一次性迁移命令；必须成功才启动新 API。 |
| `api` | 非 root Node.js 22，打包迁移与两类内置技能，`TSP_AUTO_MIGRATE=false`；`/ready` 检查实际数据库及精确迁移头。 |
| `web` | 非 root Nginx 生产静态文件，监听回环 `8088`，`/api/` 去前缀反代到回环 API `8080`，SPA fallback 和安全头沿用平台语义。 |

Compose 使用明确的 **Linux host networking**；四个服务都绑定回环，不配置公网 `ports`。这让单节点已有引擎可继续按回环接入，避免把普通 HTTP 服务名硬塞入现有的 HTTPS／loopback 约束。跨节点引擎应使用可验证 HTTPS 与私有 CA，不能禁用证书校验或放宽应用校验。

API 文件系统只读，临时文件在 tmpfs；`runtime-data` 挂载在源码目录外的 `/var/lib/team-synergy`。服务器私有 `config/runtime` 只读挂到 `/run/team-synergy`，CLI 包目录单独只读挂载。镜像不包含本机数据库、登录文件、会话、测试身份、输出目录或配置；`.dockerignore` 使用构建输入允许清单。

`api.env` 用于额外私有环境配置。`server.env` 控制端口、精确浏览器 Origin、功能开关及服务器路径；应用口令在 `db-password`，PG集群初始化管理员的独立口令在 `db-admin-password`。空卷初始化用 `init-db.sh` 建立非超级用户 `tsp` 并让其持有业务库；API和迁移容器只获得应用口令，不挂集群管理员口令。不要将 `docker compose config` 的展开结果、容器完整日志或私有备份上传到公共 Actions artifact。空库首次启动的平台管理员一次性口令只在容器私有日志中出现，首次改密流程沿用原规则。

阶段一示例明确设置记忆、系统 Agent、代码分析为关闭。它用于隔离容器烟测，**不是完整迁移的运行配置**。启用记忆前须恢复 PG 与双引擎身份／原文／向量，配置服务身份和模型并做真实读写验证。系统 Agent 还需 Linux DSH 运行时，代码分析需对应 Linux UA／CodeGraph 插件；当前镜像未附这些可选运行时，不应误称这些能力已迁。

## 构建与来源

```sh
docker build --build-arg SOURCE_REVISION=FULL_COMMIT_SHA -f Dockerfile.api -t tsp-api:FULL_COMMIT_SHA .
docker build --build-arg SOURCE_REVISION=FULL_COMMIT_SHA -f Dockerfile.web -t tsp-web:FULL_COMMIT_SHA .
```

构建使用项目固定 pnpm 10.33.0、冻结锁文件；API 完成依赖构建和打包后，`pnpm deploy --prod --legacy` 生成自包含生产依赖。最终镜像只带 API `dist`、运行包与依赖；Web 只带生成的静态文件。Node 和 Nginx 基础镜像可通过构建参数覆盖，产出镜像必须记录准确源码 SHA，发布后按 digest 使用。

`Platform containers` 在以下情况下运行：

- 相关 PR：只构建、跑守卫测试和全新隔离 PG 容器烟测，生成可验证 bundle；不发布或获取部署环境凭据。
- 可信 `main` 的现有 `CI` 成功后：验证源仓库、`push` 事件、准确 SHA 及当前 main，构建并发布镜像。
- 手动 dispatch：仅允许 main，仍要求该准确 SHA 已有成功的 main push CI。不能用手动启动绕过 CI。

旧 CI 在较新 main 之后完成会被跳过；发布前和 SSH 前再次核对。部署并发串行，原有 `.github/workflows/ci.yml` 的检查要求不变。镜像发布用 job 级 `packages: write`；生产凭据只放在受 main 分支策略保护的 GitHub `production` Environment。

每次成功构建的 `platform-images-<SHA>` artifact 包含：实际 API／Web／官方 PG16 的 `images.tar.gz`、`release.json`（源码 SHA、每镜像不可变 ImageID及已知 registry digest）、部署文件及 `SHA256SUMS`。其中不含用户数据或运行配置。

## 服务器准备与首次恢复

由有权维护者安装 Docker Engine、Compose、curl、flock 后，在服务器准备专用目录。下列命令只创建新部署目录；不要拿现有目录里的业务文件直接覆盖：

```sh
install -d -m 0700 /opt/team-synergy/{config,config/runtime,deploy,backups,releases,cli-distribution}
install -m 0600 deploy/containers/server.env.example /opt/team-synergy/config/server.env
install -m 0600 deploy/containers/api.env.example /opt/team-synergy/config/api.env
openssl rand -hex 32 > /opt/team-synergy/config/db-password
openssl rand -hex 32 > /opt/team-synergy/config/db-admin-password
chown 999:1000 /opt/team-synergy/config/db-password
chown 1000:1000 /opt/team-synergy/config/runtime /opt/team-synergy/cli-distribution
chmod 0440 /opt/team-synergy/config/db-password
chmod 0400 /opt/team-synergy/config/db-admin-password
install -m 0644 deploy/containers/compose.yaml /opt/team-synergy/deploy/compose.yaml
install -m 0644 deploy/containers/init-db.sh /opt/team-synergy/deploy/init-db.sh
install -o root -g root -m 0755 scripts/deploy-linux.sh /usr/local/sbin/tsp-deploy
```

将 `server.env` 的 `TSP_IMAGE_PREFIX` 改为允许的实际小写 GHCR 仓库前缀，路径指向本目录；选定端口、浏览器 Origin 和明确的功能开关。应用密码文件以官方PG bookworm UID999为所有者、Node GID1000为只读组，父配置目录仍仅root可遍历；更换PG发行版须重新核UID。私有运行文件需要被 API UID 1000 读取，目录及文件权限应单独设置，不能通过公开配置目录解决权限问题。CLI 分发依 [CLI 分发规范](45-cli-distribution-device-sessions.md)放入实际安装包与 manifest，静态包文件应可由API读取，空目录不代表已经发布。

迁移现有用户时先恢复到**新的目标库**并校验，再启动 API；不要走空库 bootstrap 后覆盖用户。恢复对象和停止写入点见下一节。`tsp-deploy` 只做当前目标库的部署前备份和受控版本更新，不替代首次完整恢复，也不应在本机业务库执行。

## 在线与离线镜像

在线路径为：

```sh
sudo /usr/local/sbin/tsp-deploy deploy FULL_COMMIT_SHA \
  ghcr.io/owner/team-synergy-api@sha256:API_REGISTRY_DIGEST \
  ghcr.io/owner/team-synergy-web@sha256:WEB_REGISTRY_DIGEST \
  ghcr.io/owner/team-synergy-postgres@sha256:PG_REGISTRY_DIGEST
```

服务器须实测能拉取这些层，私包还需服务器专用只读 registry 凭据；入口 `401` 可达不等于层下载可用。部署脚本只接受服务器配置的 namespace、角色和完整 digest，并核对 API／Web 源码标签及 PG16 版本。

若服务器 registry 访问慢，维护者可通过已认证 GitHub CLI 下载**可信 main 准确 SHA** 的构建 artifact，再经 SSH 传入服务器。先核对构建来源、源码 SHA 和所有校验和，再导入：

```sh
cd /private/path/to/verified-bundle
sha256sum --check SHA256SUMS
docker load --input images.tar.gz
docker image inspect sha256:API_IMAGE_ID --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
sudo /usr/local/sbin/tsp-deploy deploy-loaded FULL_COMMIT_SHA \
  sha256:API_IMAGE_ID sha256:WEB_IMAGE_ID sha256:PG_IMAGE_ID
```

这里使用 `release.json` 中的 **ImageID**，不是自行 retag 得到的 registry digest。`docker save/load` 不保证保留 `RepoDigests`。离线模式明确不拉镜像，逐项核对本地 ImageID、源码标签和 PG 版本，Compose 固定 `pull_policy: never`。它与在线 registry manifest digest 是两种来源证明，不能互相冒充。首次部署仍须记录实际 smoke，不能只凭 manifest 宣布容器已启动。

## 自动 SSH 部署的配置

初期默认 `TSP_DEPLOY_ENABLED` 未启用：CI 成功只生成／发布镜像并明确报告没有部署服务器。准备完成后，在 `production` Environment 设置专用 `TSP_DEPLOY_HOST/PORT/USER/KEY/KNOWN_HOSTS`，并把 repository variable `TSP_DEPLOY_ENABLED` 设为 `true`。

`TSP_DEPLOY_USER` 使用专用非 root 用户，不能加入 docker 组；不能上传操作者的 root 私钥。仅为这条流水线创建独立密钥，服务器 `authorized_keys` 使用 `restrict,command="sudo -n /usr/local/sbin/tsp-deploy"`。以 `visudo` 校验并安装 `deploy/containers/sudoers.example`，仅保留 `SSH_ORIGINAL_COMMAND`，只允许无额外参数的 root-owned 固定入口。入口再将请求按普通字段解析，拒绝命令注入、错误角色、非允许镜像、错误源码和路径链接；不 `eval` 或 source 远端输入。

`KNOWN_HOSTS` 必须来自已验证的服务器 host key，不能在部署时盲目信任 `ssh-keyscan`，也不能关闭 StrictHostKeyChecking。GitHub Environment 仅允许 main，并按项目制度设置审批。专用密钥仍是部署权限，保存和撤销均应可审计。

## 更新、备份与失败

脚本先拿独占锁、拉取／检查镜像，再停止 API/Web 写入入口，启动健康 PG，生成私有 custom-format dump 及 SHA256，运行独立 migration，再启动新 API/Web，并检查真实 `/api/ready` 与静态入口。成功后才原子更新活动版本。原 API 初始化口令和完整日志不输出到公开 CI。

失败保留日志、备份与阶段记录；有前一版本时只尝试恢复应用镜像，并记录是否健康，仍返回失败。**不会自动恢复数据库。** 新 schema 可能使旧 API 的精确迁移头检查失败，需人工选择已验证的前向修复或停写后恢复备份；不能删除卷、降低 readiness 或把旧镜像启动当作 DB 已回退。回收备份和卷另行管理，更新脚本不自动清理它们。

## 本次迁移清单与尚需验证事项

只读盘点约为：业务 PG 338MiB，其中代码理解历史约313MiB；Tencent持久数据20MiB；OpenViking22MiB；另有9个现存历史文件和2条本来已缺失的引用。附件、技能版本、项目/账号绑定与任务事实在PG；记忆原文、SQLite/WAL、向量、服务身份并不全在PG dump内。

需冻结写入并记录一致性时间点，使用 PG dump 与 SQLite备份／停机快照，完整迁原文、身份和关联索引；不能在线只复制 `.sqlite` 主文件。恢复后逐项核数量、来源、映射、文件 hash、中文检索和跨项目隔离。本地 Windows `file:` 历史引用必须归档并确定服务器读取方式；原本缺失的2项保留缺失事实，不伪称恢复成功。

Tencent 当前行为包含6个本地源码修改和未发布补丁，需要固定 upstream SHA并版本化审查后的输入；只拉 upstream不能复现。OpenViking源码虽干净，也需要Linux兼容运行时、持久目录与配置。测试集群、原始实验日志、临时worktree和无关模型缓存不作为业务数据迁移。

本地7.6B Qwen模型约4.68GB，两台2GB机器无法照搬。服务器Magpie独立登录，部署后通过隧道交给操作者授权 DeepSeek V4.1 Flash，不复制会互相消费refresh token的本机OAuth文件。BGE-M3为1024维、约1.16GB，必须保持模型兼容并做热态内存／延迟／并发验证；冷态进程小、两机总内存或新增swap都不等于可用生产容量，不能静默换嵌入模型。

无域名阶段使用 `ssh -L 18080:127.0.0.1:8088 ...` 后访问 `http://localhost:18080`，`TSP_WEB_ORIGIN` 必须相同。生产 Secure／`__Host-` Cookie、CSRF 保持；用 localhost 区别于原本 `127.0.0.1` 开发站点，避免跨端口旧 Cookie 冲突。浏览器实际登录仍须验收；公网正式服务另配有效域名与 HTTPS。

任务、Run、PR及合入验收按 [任务到 PR 规范](82-agent-task-pr-workflow.md)执行。以上所有阶段边界、未恢复项和容量结果应在平台验收中如实记录。

参考：[Docker Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)、[pnpm 容器打包](https://pnpm.io/docker)、[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)。

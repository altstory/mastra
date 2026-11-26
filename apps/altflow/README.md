# Altflow 应用

Go 后端复用 AltFlow 的密码登录、令牌校验、退出和账号角色。TypeScript/Mastra 负责 Agent、模型、会话记忆和知识库。认证接入不依赖 Mastra Enterprise 登录或 RBAC。

## 本地启动

本应用位于主仓库的 `apps/altflow`，与 `packages/playground`、`packages/playground-ui` 和 `integrations/altflow-tools` 一起由 `altflow` 分支维护。框架及工具依赖使用 `workspace:*`，安装时由根目录的 `pnpm-lock.yaml` 锁定，无需原来的独立 `mastra-preview` 目录。

需要 Node.js 24.11+、仓库指定的 pnpm、Go、PostgreSQL 和已配置的 AltFlow 账号库。从仓库根目录执行：

```sh
pnpm install --frozen-lockfile
cp apps/altflow/.env.example apps/altflow/.env
# 填写 apps/altflow/.env 后构建应用及其依赖
pnpm exec turbo build --filter=@internal/altflow --concurrency=1
```

构建依赖时逐包执行；不要从仓库根目录直接运行应用的 TypeScript 配置。

1. 启动本地 Go 后端，在 `apps/altflow/.env` 配置 `ALTFLOW_BACKEND_URL=http://127.0.0.1:8080`、`ALTFLOW_AUTH_IDENTITY_ENDPOINT=me` 和 `ALTFLOW_MODELHUB_API_KEY`。使用提供 `/auth/validate` 的部署时，将 `ALTFLOW_AUTH_IDENTITY_ENDPOINT` 设为 `validate`。
2. 配置服务端 `ALTFLOW_OSS_ACCESS_KEY_ID`、`ALTFLOW_OSS_ACCESS_KEY_SECRET`，以及 `.env.example` 中的 OSS 桶和区域。
3. 运行 `pnpm --filter @internal/altflow start`，监听 `127.0.0.1:4111`。`dev` 提供热重载，使用 DuckDB 时优先使用单进程 `start`。
4. 运行 `pnpm --filter @internal/playground dev --port 5174`，将 `/api`、`/account`、`/storage`、`/conversation-projects`、`/account-preferences`、`/altflow` 代理到 4111。

正式部署配置 `STUDIO_ALLOWED_ORIGINS`，并使用 HTTPS 和持久化存储。

### 构建与内存

全量构建依赖会同时编译几十个包，turbo 默认并行数等于核数，16GB 内存的机器可能因此内存耗尽。

- 构建依赖用 `pnpm --filter @internal/altflow build:deps`：并行数限为 2，单个 node 进程堆上限 2GB，跳过 `@mastra/playground-ui`（本应用不需要，且最重）。macOS 上交换区已用超过 3GB 时拒绝执行，确认可以继续时加 `-- --force`。
- 只改了 `.env` 或数据时，不需要重新构建：用 `pnpm --filter @internal/altflow start:prebuilt` 直接启动已有的 `.mastra/output`。`start` 每次都会先删除输出里的 `node_modules` 再完整构建。
- 只跑应用测试（`test`、`test:tools`）时，不需要在每个新 worktree 里重新构建依赖；复用已构建过的检出。

### 已有数据

源码合并不移动现有安装的数据库、环境文件、上传资料或工作区。切换服务前，停止旧进程并备份数据；通过 `ALTFLOW_RUNTIME_ROOT` 指向原有数据根目录，即可沿用原目录下的 `src/mastra/public/preview.db`、`data/`、`workspace/` 和 `.cache/embeddings/`。`MASTRA_PREVIEW_ROOT` 作为旧配置别名继续兼容。不要让两个进程同时打开同一个 DuckDB 文件。

## 模型

只注册 AltFlow ModelHub 网关，隐藏 Mastra 公共模型供应商。目录来自 `https://modelhub.altflow.cn/v1/model-catalog` 的 `free_chat_models`，不使用包含内部路由的 `/v1/models`。

选择器展示目录中的产品名称。所有登录用户都可切换 Qwen3.8 Flash 和 Qwen3.8 Max，并调整当前模型的思考强度。档位来自每个模型的 `thinking_options`，切换模型时使用新模型的默认档位；选择保存在当前会话偏好中。实际调用由服务端验证所选档位，并根据该档位转换为 `target`、思考强度及预算，记录目录版本。默认使用 `altflow/qwen3.8-max` 的 `medium` 档。目录缓存 60 秒，刷新失败保留上次有效目录；首次获取失败时不提供公共模型作为替代。这里沿用 DSH 的目录、档位选择和路由规则。

ModelHub 适配器显式启用 `includeUsage`，流式请求携带 `stream_options.include_usage=true`，要求上游返回输入、输出和缓存用量。缓存是否命中由上游决定，本地 TokenCounter 只做上下文预算，不能测出供应商缓存命中。被中断的请求仍可能没有最终 usage，前端将其他已报告用量标为 `≥`，不把缺失值当成 0 或丢掉已有统计。

## 权限与数据

- `admin` 角色显示管理入口。`creator`、旧 `user` 角色可以对话和使用自己的文件工作区。每次 API 请求向 Go 校验身份，角色变更、停用、退出立即生效。
- Cookie 使用 HttpOnly、SameSite=Lax；生产环境附加 Secure。写请求校验 Origin，远程认证服务必须 HTTPS。前端隐藏入口之外，服务端也检查权限及配置覆盖。
- 会话、消息、工作记忆、观察记忆、私人知识按 Go 用户 ID 隔离，管理员也不能读取其他用户的这些私人数据。
- `library:creator` 和共享 Skill 由管理员维护，Agent 可以在内部查阅。普通账号的 API 响应隐藏内部资料清单及原始工具记录。[内部资料防爬设计](./INTERNAL-REFERENCE-POLICY.md)
- 全局管理员工作区、工作流记录和全局追踪/日志由管理员共享。正式多租户场景需另行拆分这些资源。
- `ALTFLOW_LEGACY_OWNER_ID` 可将接入账号前的本地会话明确归属给一个用户，默认不映射。

## 能力和持久化

默认开启工作记忆、中文标题和 DSH 检查点压缩。Agent 默认无需审批即可执行已提供的工具。共享 Skill 与创作知识由普通用户对话中的 Agent 内部使用，原文和内部调用记录不对用户展示。知识库管理、编辑器、MCP 及全局可观测性保留给管理员。所有已登录用户均可通过 Agent 使用自己的私有文件工作区。

Web 自由创作会话通过 Go 网关使用 Mastra 的标题、会话记忆、任务与交互工具。用户明确自述的姓名、常用称呼和长期偏好可在同一账号的新会话中使用，创作内容、待答问题和文件访问仍按会话隔离。Web 只展示可公开的任务与工具状态。

生成中可以把消息排入队列，或立即发给当前运行作为引导。Mastra 会在下一个可处理的位置接收引导。当前运行已结束时，Web 会保留这条消息并提示重新发送。

普通账号可以使用 `GET /altflow/conversations/metrics?threadId=<会话 ID>` 读取自己的会话统计。响应包含 `metrics`（每次运行的步骤数、耗时、用量和上下文占用）和 `incomplete`（是否有尚不可读取的记录）。原始追踪接口由管理员使用。

### DSH 上下文策略

- 运行窗口采用本机 DSH ModelHub 集成的 `131,072` tokens，主模型输出最多 `8,192`；上游 `/model/info` 给出更小输入容量时取较小值。UI 展示该实际运行窗口，不再把物理 `1M` 容量当作会话预算。
- 每一步模型请求之前重新检查压力。默认阈值为 `min(窗口 × 0.8, 窗口 − 输出预留 − 65,536)`，当前为 `57,344` tokens。保留尾部预算为 `(窗口 − 输出预留) × 0.16`，当前为 `19,660` tokens。
- 先裁剪超过 8,192 个 Unicode 字符的工具文本，保留前 4,096、后 1,024；仍有压力时，用最近回答的模型生成结构化检查点。摘要内容按创作场景区分已确认决定、候选方案、待决定事项和文档版本；DSH 的触发、预算、检查点持久化与重放机制不变。工具调用与结果保持配对，当前用户请求始终保留。摘要最多预留 65,536 输出 tokens，并受摘要模型剩余容量约束；摘要不能执行工具。
- 检查点写入所属 thread 的 metadata。原始消息与工具结果保留在数据库；重启后重放检查点及近期原文。取消、空摘要、输出截断、不缩小及并发检查点冲突均不会覆盖历史。确认的上下文溢出仅重试一次，且必须先成功缩小请求。
- 关闭原先的 `48K` 截断器和观察记忆投影，避免两套历史压缩互相覆盖；旧观察记录不删除。工作记忆和自动语义召回限制在当前会话，作者偏好单独保存。
- 与 DSH 一样，触发压缩的内部压力会使用提供方真实输入用量加后续消息增量；尚无用量时采用固定密度计价。UI 占用只显示提供方实际 input tokens，不把内部压力估算当作实际 token 数。
- “轮”是至少完成一个主模型步骤的用户执行；“步”是已结束的主模型调用。工具执行、标题、压缩和子 Agent 调用不额外算作主 Agent 步数，辅助调用费用仍计入总用量。

`workspace/` 是本机文件区，初始为空。自定义稿件和技能按需放入，不随源码提交。首次启动创建共享创作指南，不覆盖已有资料。语义向量使用本地多语言 MiniLM（384 维），首次下载约 144 MB，缓存到 `.cache/embeddings/`。

`src/mastra/public/preview.db` 保存会话、知识、工作流和编辑器配置；`data/vectors.db` 保存向量，`data/observability.duckdb` 保存追踪等数据。数据库、环境文件、缓存、工作区都不纳入 Git，部署时须单独持久化和备份。

## 验证

- `pnpm --filter @internal/altflow typecheck`：配置与适配器类型。
- `pnpm --filter @internal/altflow test`：真实 AI SDK 通过本地 HTTP ModelHub 测试服务验证目录校验、模型路由、默认思考参数、刷新与故障缓存，以及真实 Agent + 临时 LibSQL 的压缩、恢复、工具配对、模型切换、取消和溢出重试；不调用付费模型。
- 通用设置中的“繁忙时的发送行为”默认排队发送。Enter 和发送按钮遵循该选项，Cmd/Ctrl+Enter 使用另一行为；可切换为插话发送。普通用户的两种发送方式均由服务端检查会话归属。

## 用户文件与 512 MB 配额

### Office 正文读取

`read_document` 使用 DSH 同版本的 `@deepseek-ai/libreoffice-kit@0.2.3`，支持 Word（DOC/DOCX/ODT）、Excel（XLS/XLSX/ODS）、PowerPoint（PPT/PPTX/ODP）及有文字层的 PDF。Word 导出正文；表格和演示文稿先渲染为 PDF，再提取页面文字。现有 `read_file` 的文本读取也会转入此解析器，原始文件不变。

解析前检查账号文件权限；临时文件随请求清理。沿用 DSH 的 50 MB 输入、60 秒转换、2 个并发和 8 个排队请求限制。正文按行分页返回，单次最多 80,000 字符。扫描件 OCR 不在此能力内；没有文字层时明确报错。运行此功能的主机需安装锁文件中对应平台的 LibreOffice Kit 原生依赖。

`pnpm --filter @internal/altflow test:tools` 使用真实 Office 引擎、合成文档和隔离文件账本，验证正文、原文件不变、跨账号拒绝及 Agent 文件工具链路。

- 文件内容使用阿里云 OSS 官方 Node.js SDK、V4 签名和 HTTPS，写入私有桶 `altflow-harness`。对象键为 `users/<用户ID的SHA256>/objects/<UUID>`；文件名和权限由服务端账本管理，不接受前端传入的用户 ID。密钥只在服务端环境中配置。
- `data/user-files.db` 保存路径、文件大小、来源、摘要、配额预留和失败清理记录。它是新建的专用文件账本，不修改账号/会话库 schema。部署时必须同时持久化、备份该账本与 OSS 对象；多实例须使用同一个账本，不能各自用本地 SQLite。
- 每个账号 `512 × 1024 × 1024` 字节。上传和 Agent 写文件共用事务配额预留，并发上传不能超额。相同上传 ID 与内容可安全重试；覆盖只计算新旧文件的大小差额。删除 OSS 成功后才释放容量；失败保留文件及容量。覆盖产生的旧对象清理失败会持久化记录，启动时和每 10 分钟重试。
- 附件先保存再发送消息。文本/其他文档通过工作区文件工具读取，图片和 PDF 同时保留原生模型输入。Agent 的文件工具、`project_status`、`read_document` 和 `present` 只访问当前会话文件；同一会话的子 Agent 共享该范围。不同会话写入同名路径不会覆盖彼此，容量仍按账号累计。生成文件在设置的存储页可下载。
- 新上传的文件只有随用户消息明确附加后，才进入该会话。旧文件只根据唯一会话的写入记录和当前内容版本恢复归属；归属不明确的文件保留在账号存储页，不自动开放给 Agent。编辑旧文件或附件会生成当前会话副本，原件保留。
- 会话文件面板通过 `/storage?thread=<会话 ID>` 获取隔离列表，并校验会话所有权；账号存储管理仍可查看自己的全部文件。逻辑路径用于 Agent 读写，`storagePath` 用于已有的鉴权预览和下载接口。
- Web 自由创作的会话文件面板支持下载和编辑 Agent 生成的文本文件，最大可编辑大小为 10 MiB。保存前校验文件版本，冲突时保留用户草稿。
- `/storage`、`/storage/upload`、`/storage/download`、`/storage/file` 每次复用 Go 身份验证；Cookie 写请求校验 Origin，下载无公共 OSS URL。页面支持容量条、文件/图像分类、搜索、下载、删除确认和错误恢复。
- 当前身份需有桶内 `users/*` 的 `oss:PutObject`、`oss:GetObject`、`oss:DeleteObject` 权限。验证前缀 `integration-tests/*` 用于独立连通性检查。删除权限缺失时页面会报错，不会伪造删除成功。
- `node --import tsx scripts/import-legacy-files.mjs` 可恢复历史会话中的原始文本附件和内联文件，按会话账本归属写入用户空间。旧 `creator-agent` 资源必须有明确的 `ALTFLOW_LEGACY_OWNER_ID`；不推断归属、不下载历史外部 URL、不改写会话，重复执行不会重复占用空间。
- `pnpm --filter @internal/altflow test` 包含真实 OSS SDK 对接本地 HTTP 边界、真实临时 LibSQL、真实文件适配器和 HTTP 路由验证，覆盖并发配额、身份隔离、Origin、重启恢复、读取/生成、下载和失败删除。

官方参考：[Mastra 文件系统](https://mastra.ai/docs/sandbox/filesystem)、[OSS Node.js SDK 初始化](https://www.alibabacloud.com/help/en/oss/initialization-10)。

## 本地集成启动

`pnpm --filter @internal/altflow start` 通过 `start-built.mjs` 编译后启动 4111 服务。它使用本仓库的 workspace 框架及工具包，不在输出目录重新安装公开包，以免覆盖本地框架实现。此入口没有热重载；修改运行代码后重新执行。Studio 开发入口仍为 5174。

部署时须携带本分支构建的框架依赖与根锁文件；公开 registry 中的同名包不能替代本分支实现。动态子智能体的契约、界面及验收边界见 [DSH-SUBAGENT-HANDOFF.md](./DSH-SUBAGENT-HANDOFF.md)。

## Context component estimates

`ContextCompaction.processLLMRequest` uses the exported Mastra `TokenCounter` from `@mastra/memory/processors` to count system instructions, converted conversation messages (including attachments), and tool definitions after pruning and checkpoint projection. The numeric estimates are persisted as `contextBreakdown` metadata on each model-step span. The UI labels these with `~`; aggregate occupancy and uncached-input usage continue to use the provider's reported usage. Historical traces without this metadata cannot retroactively acquire exact component counts.

DSH pressure pricing remains separate from these display estimates: trigger at `floor(min(W * 0.8, W - O - 65536))`, retain `floor((W - O) * 0.16)`, using a configured maximum window of 262144 and output reserve of 8192. Full original messages remain in memory storage.

DSH checkpoint compaction is the only conversation compression mechanism. Mastra
loads the complete stored history instead of its default recent-message count;
observational memory is disabled so its observation cursor cannot hide original
messages before DSH applies its checkpoint. Existing observation records remain
stored but are not injected. Managed-user requests cannot re-enable observations or impose a
message-count cap. At the default capacity, AltFlow attempts compaction before
the main model request once it estimates 188416 input tokens, keeping a recent
verbatim tail budget of 40632 tokens. The context window is capped by the
selected model route when it has a smaller capacity. Checkpoints persist with
the thread and reload when the Agent is rebuilt.

## Master memory switch

The creator Agent enables working memory, semantic recall, and DSH-managed
conversation history on the server. General settings exposes one master
switch. Disabling it sends an invocation override that disables those channels;
saved conversations are retained. Retired per-feature browser preferences no longer
override the server policy.

## 创作记忆的内容与范围

记忆写入仍由 Agent 在对话中调用工具完成，内容按用途分层：

| 内容                                           | 保存工具                         | 自动读取范围                 |
| ---------------------------------------------- | -------------------------------- | ---------------------------- |
| 用户明确表达的长期作者偏好                     | `remember` / `author_preference` | 同一账号的会话               |
| 用户确认的项目形式、主题、禁区、采用的创作规范 | `remember` / `project_agreement` | 同一账号、同一关联项目的会话 |
| 已确认的人物、世界规则、关键事件及适用版本     | `remember` / `story_fact`        | 同一账号、同一关联项目的会话 |
| 当前目标、候选方案、假设、待选问题、执行进度   | `updateWorkingMemory`            | 当前会话                     |

项目归属复用 `/conversation-projects` 的服务端记录，不从作品名、消息内容或模型参数推断。未关联项目时，作品信息暂留当前会话；不能改存为作者偏好。移动会话后，自动加载的项目记忆随归属变化，该会话自己的历史消息仍然保留。

上传或读取创作宪法、技能、范例，不代表采用其中的规则。只有用户明确采用的条款才应形成项目约定；引用文件的条目必须保存文件路径、版本和简洁摘要。服务端校验当前账号的文件访问权限并记录文件更新时间；来源变更、不可访问或条目过期后，不再自动注入旧内容。

`remember` 和 `forget_memory` 必须引用本轮用户消息中存在的原话。服务端校验账号、会话、项目归属、原话、字段和版本；是否构成明确确认、应该归入哪一类，仍由模型根据记忆规则判断。原话校验不能证明语义判断一定正确。只有旧消息或工具返回中的文字不能直接作为本轮确认；缺少本轮用户原话时，继续保留在会话工作状态。

同一条事实使用相同 `kind`、`key` 和最新 `revision` 更正，过时修订会被拒绝。每个作者或项目范围最多保留 64 个未删除条目；满额时合并或更正已有条目。`forget_memory` 删除该条目的内容并保留修订标识，不删除历史聊天中的原话。历史自由文本工作记忆不会自动迁移成已确认的长期条目。

新账本为 `data/creative-memory.db`，必须与账号设置、项目归属、用户文件及会话库一起持久化和备份。多实例须共用同一账本。它不修改 Go 账号库。关闭记忆总开关会停止这些条目的自动读取，并撤下记忆写入和删除工具；已有数据保留。

`scripts/memory-isolation.test.mjs` 使用真实 Agent、临时 LibSQL、文件存储与 HTTP 模型边界，覆盖 `stream` / `generate`、账号/项目/会话隔离、重建后恢复、来源验证、版本更正、并发冲突、文件变更、过期、删除和关闭开关。模型响应是脚本化的，不替代真实模型的语义抽取质量评估。

## 项目与会话分组

- `/conversation-projects` GET/POST 是服务端认证接口。项目名称、会话归属、项目/会话置顶和折叠状态按账号保存于 `data/conversation-projects.db`，不依赖浏览器保存业务状态。Studio 开发代理和正式反向代理需转发此根路径。
- 写入使用创建、重命名、移动、置顶等命令，在写事务中读取最新状态并更新，避免多个页面用旧快照覆盖新数据。服务端从登录态确定账号；移动、置顶、迁移和删除都会验证会话归属。
- 老浏览器仅导入当前账号精确作用域下的旧数据，成功后清理备份。服务端保留迁移指纹，已有服务端记录优先；相同旧数据不会重新创建已删除项目。
- 删除项目的成员列表由服务端读取。删除部分失败时保留项目及未成功删除的会话，可重试；用户文件遵循原有生命周期，不随项目删除。
- 部署必须持久化并备份此账本和会话库。多实例必须共用账本，不能各持一份独立 SQLite；该账本不修改 Go 账号库或 Mastra 会话库 schema。
- `scripts/conversation-projects.test.mjs` 通过真实 HTTP 认证边界、路由和临时 LibSQL 验证跨账号隔离、重启恢复、并发修改、迁移及故障删除重试，不访问正常业务库。

### Account preferences

`/account-preferences` reads and patches memory, chat, agent editor and thread
preferences for the Go-authenticated account. The independent ledger is
`data/account-preferences.db`; keep it in server backups with the project and file
ledgers. Writes validate a per-kind schema and merge fields in a write transaction.
Cookie writes require an allowed Origin; response bodies never select an owner.
Legacy thread imports require a pre-existing owned thread and never replace an
existing server entry, including an explicit reset. The creator Agent resolves
its memory policy from this ledger; a persisted opt-out blocks history, semantic
and working-memory recall even when a client sends stale enabled options.

## 自主创作引导

用户正常描述需求，Agent 按当前问题组合已发布的创作技能，用 ask_user 展示一次一题的问答卡片。title/context 提供问题背景，选项支持说明和推荐标记，仍沿用原生暂停与恢复；回答结果保留 question/answer 供聊天历史展示。

需求够用时通过 show_creative_brief 展示已确认、假设和待定事项，并将同一份要求写入当前项目的 00-需求确认.md。剧本通过格式校验后交付，整体质检工作流暂未启用。

代码维护的技能发布：pnpm --filter @internal/altflow publish:creator-skills。运行代码和已发布技能是两个更新步骤；发布技能保留历史版本，当前对话下一次创建工作区时读取活跃版本。

## 自由创作长任务与协作状态

自由创作不按累计 token 或固定调用次数终止任务。主 Agent、子 Agent、压缩和重试共用计费记录；上下文长度仍由现有 checkpoint 压缩管理。

`ALTFLOW_CREATOR_TOKEN_BUDGET` 是首次费用预留的 token 估算量，不是任务总上限。预留即将不足时，Agent 暂候 Go 按原价格与折扣快照追加费用预留，再继续同一 operation。追加请求重放不重复扣款；结束时按真实用量结算并退还未用预留。余额不足或预留服务故障会明确中断，保留已保存进度供用户继续。单次请求仍受模型自身上下文与输出窗口约束。

主代理的单次回复结束不代表整个 operation 完成：后台子代理及其唤醒的主代理共享原费用预留，全部结束后才结算。唤醒产生的新 runId 会更新回执，等待用户回答时保留原 operation；Go 在引导或回答遇到尚未同步的 runId 时先回读回执。续额确认按额度单调更新，迟到的旧拒绝不能覆盖新批准。

产品页的协作任务侧栏读取现有子 Agent runtime 的状态、最近回复和工具进度。读取不启动或恢复模型执行，不返回内部错误、提示词或 token 统计。创作问题使用已有剧本规范，只询问内容取舍；重复的待回答事件按工具调用 ID 合并。

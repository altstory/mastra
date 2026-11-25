# 创作者助手工具

公共工具库位于 `integrations/altflow-tools`，应用组装位于 `apps/altflow`。两者均由主仓库的 `altflow` 分支维护。

## 能力

显式工具：count-text、web_fetch、ask_user、submit_plan、task_write、task_update、task_complete、task_check、session_search、present、validate_script_format、project_status、analyze_script_graph、show_branch_graph、show_creative_brief、show_creative_work、deliver_interactive_script、story_ledger_read、story_ledger_save。配置搜索凭据后再注册 web_search，共 19 个。另有动态子智能体与团队工具 10 个：subagent、subagent_fork、list_agents、send_message、wait_agent、interrupt_agent、team_task_create/get/list/update；总计 29 个，配置搜索后为 30 个。

工作区文件、知识库、技能、recall、工作流仍使用 Mastra 原生工具。动态子智能体基于原生 Agent/Memory/Signal 运行，调度与持久化由 `subagents/` 管理。`/altflow/tools/catalog` 是鉴权只读目录，显示来源及未配置原因，不提供运行时工具的无会话执行旁路。

没有新增定时任务。当前 recall 提供历史浏览，没有开启观察记忆向量检索。

## 本地安装与验证

`package.json` 使用 `workspace:*` 引用同仓库的框架和工具包。从仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @mastra/altflow-tools build:lib
pnpm --filter @internal/altflow typecheck
pnpm --filter @internal/altflow test:tools
pnpm --filter @internal/altflow test
```

工具包源码改变后先重新构建，无需复制安装包。UI 位于 `packages/playground` 与 `packages/playground-ui`。

## 搜索配置

默认 provider 为 Tavily，配置服务端 TAVILY_API_KEY。也可以设置 ALTFLOW_SEARCH_PROVIDER=deepseek，另配 DEEPSEEK_SEARCH_API_KEY；可选 TAVILY_SEARCH_URL / DEEPSEEK_SEARCH_URL 均为完整搜索 endpoint。只允许 HTTPS（本地测试地址除外），不跟随重定向。

未配置时模型看不到 web_search，目录显示未配置。不能把 ModelHub 聊天 key 当搜索 key 发给其他服务。

## 委派策略

依据 DSH 源码：`packages/subagent/subagent/src/index.ts` 默认 maxActiveSubagents=8、maxDepth=1；`packages/core/agent-loop/src/constants.ts` 默认并行工具容量 10。8 是活跃容量，不是步数。

`agents/execution-policy.ts` 统一执行容量。ALTFLOW_MAX_ACTIVE_SUBAGENTS、ALTFLOW_MAX_PARALLEL_TOOL_CALLS 可覆盖默认值。Mastra 数字 maxSteps 使用 MAX_SAFE_INTEGER 适配持续执行，不额外设置固定步数预算。

动态助手独立后台运行，完成后通知主智能体；可分叉、发现、消息、等待、打断与继续。团队开关只控制共享任务板。任务、消息和子会话元数据均保存到服务端 LibSQL。详细契约、冷恢复与验证边界见 `DSH-SUBAGENT-HANDOFF.md`。

认证在每次请求覆盖 mastra__altflowAccountResourceId；客户端不能提供 mastra__* 覆盖。子智能体继承账号文件授权，保留树内私有 Memory resourceId；普通侧栏不会列出子会话。

present 只引用现有用户文件，不重复计入 512MB 配额。下载重新校验账号与路径；不信任模型提供的任意下载地址。公共技能来自受 realpath 约束的只读源。

## 验证边界

自动验证使用真实 Agent 循环、SQLite、文件账本、HTTP、提问/审批暂停恢复、动态后台运行；付费模型和 OSS 外部服务边缘用本地协议样本。真实搜索 provider 调用及真实 DeepSeek 搜索引用仍需单独的搜索凭据。

## 按需启用工具与文件交付

对话只在当前请求涉及字数、字符数或段落数时提供 countText。Office 转换、版式渲染和公式重算工具在对应请求或加载 Office Skill 后可用。Office 工具写入独立产物，通过 present 交付。渲染一次最多 8 张 PNG。

同一轮连续使用同一工具和参数达到 3、5 或 8 次时，给模型一条提示。大文本工具结果在模型请求中缩成预览，模型可以通过 read_tool_result 分页读取原文。原始结果保留在会话记录中。

按会话轮次记录文件新增、修改和删除。UTF-8 的 TXT 和 Markdown 文件在每个版本不超过 64 KiB 时提供逐行对比，其他文件显示变更类型。变更历史随文件索引保存。

## 自主澄清与提问卡片

Agent 根据任务读取并组合已发布技能，不提供斜杠入口，也不强制完整走一遍流程。ask_user 复用 Mastra 原生暂停/恢复，在应用层增加 title、context、选项说明和单个 recommended；成功回答保留完整题目、背景、原始选项、preview 和 answer，供前端回显。一次只问当前最重要的一题，用户可以自由回答或要求跳过。

show_creative_brief 展示 confirmed、assumptions、undecided 三类创作要求。它不写文件，也不表示用户批准；Agent 用现有文件工具同步保存 00-需求确认.md，后续创作和质检读取同一份要求。

## 创作过程中的成果与反馈

show_creative_work 接收 `{ work }`，按 work.kind 展示 directions（2–4 个方案）、characters（1–6 个人物）、outline（1–12 个情节节点）、excerpt（最多 8000 字符的试写）或 document（1–8 个分节摘要，每节最多 3000 字符）。它只展示，不保存文件、不表示用户确认。

ask_user 的可选 preview 接收同一结构，在问题上方展示所评阅成果；暂停载荷和成功回答都保留 preview、背景和全部原始选项，刷新后仍可回看当时版本。需要反馈时直接使用 ask_user.preview，不先重复调用展示工具。普通初始问题不必带预览。继续复用原生 suspend/resume，不新增审批机制。

Agent 在新提案、关键取舍和大篇幅扩写前邀请反馈；没有待决定事项时展示后继续，用户明确授权全程自主完成时减少打断。每份新创作文档及重要修订都展示实际内容，相关成果可合并但不能遗漏。流程不固定，不能只问开头、随后连续生成多个文档而不展示实际内容。

## 可交互阅读

characters 可附 relationships（from/to 为现有人物 name），用于关系图和人物切换；outline 可附 emotion、details，用于时间轴展开。script 包含 start 和 scenes，场景以 blocks 区分动作与对白，以 choices 或 ending 收束。输入 schema 拒绝重复 ID、悬空引用、不可达场景、环和同时包含选项与结局的节点。它仅是无状态短样段预览，不代替完整互动剧本格式或状态引擎。

revision 使用真实 before/after 文本和 reason，前端复用既有逐行差异算法，支持改动摘要与全文对照。所有阅读操作均在页面内进行，不调用 ask_user 恢复；创作意见仍由问答提交。

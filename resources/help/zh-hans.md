# PKM 实用指南：从第一条笔记开始

PKM 帮你保存有用的知识、在需要时找到它，并让 AI 助手带着正确的上下文完成工作。先做一件小事：**保存一条笔记，重新打开，再让 Agent 使用它**。不用先配置所有复杂功能。

这是一份给使用者看的指南，不是开发手册。文中的链接会打开对应的 PKM 页面。**复制给 Agent 的指令**只会复制文字：把它粘贴到你选择的聊天中，替换方括号里的内容，再确认 Agent 将要执行的操作。

## 1. 保存你的第一条笔记

**适合保存：**会议记录、决策、排障过程，以及不想遗失在聊天历史里的信息。

1. 打开 [Notes（笔记）](pkm-help:notes)，点击 **Note**，选择 Markdown。
   如果还没选 Knowledge Root，先在 [General & MCP](pkm-help:mcp) 选择存放知识的文件夹。这只是存储位置的选择，不要求先完成 MCP 配置。
2. 起一个能看懂的标题，选择文件夹，写几行内容并保存。
3. 从列表里重新打开，确认保存成功。以后可用搜索框找回来。
4. 想让 Agent 使用这份资料时，右键复制笔记的 PKM 路径，避免让它猜是哪一条。

**Knowledge Root（知识目录）**是 PKM 保存内容的文件夹。普通笔记和技能是 Markdown 文件。**基础笔记和技能不需要 Python、MCP 或下载向量模型。**Todo Board 是结构化任务看板，应使用它的操作界面，不能靠直接编辑 Markdown 来管理任务。

复制的 PKM 路径用于标识资料，不会授予读取权限。如果所选 Agent 的工具无法读取它，可以打开笔记，粘贴相关内容或附上 Markdown 文件。需要外部 Agent 通过工具读写 PKM 时，再配置 MCP。

顶部的 **Go to PKM Path** 可以打开 Agent 给出的条目链接。Skills、Notes、Research 同时支持不带扩展名的条目 slug 和带 `.md` 的文件路径，例如 `pkm://skills/Coding/Review` 与 `pkm://skills/Coding/Review.md`。只按当前知识目录中的完整路径或 slug 精确匹配，不会根据标题猜测，也不会打开文件夹；找不到或存在歧义时会明确报错。

```agent
读取这条 PKM 笔记：[粘贴右键复制的 PKM 路径]。
总结其中的决策和未解决问题，不修改原笔记。
区分哪些结论有原文支持，哪些还需要澄清。
```

## 2. 我该把东西放在哪里？

| 你想保存或完成的事 | 去哪里 |
| --- | --- |
| 事实、会议记录、决策 | [Knowledge → Notes](pkm-help:notes) |
| 可以反复使用的方法和操作规范 | [Knowledge → Skills](pkm-help:skills) |
| 论文、结论、引用关系和研究想法 | [Knowledge → Research](pkm-help:papers) |
| 多版本的提示词模板 | [Tools → Prompts](pkm-help:prompts) |
| 脚本、代码包、Python 环境、本地服务 | [Scripts](pkm-help:scripts)、[Packages](pkm-help:packages)、[Environments](pkm-help:environments)、[Servers](pkm-help:servers) |
| 任务目标、负责人、依赖和验收 | 从 [Notes](pkm-help:notes) 创建 **Todo Board** |
| 持续对话、项目和讨论主题 | [PKM Chat](pkm-help:chat)、[Projects](pkm-help:projects)、[Threads](pkm-help:chatroom) |
| 可重复执行的自动化流程 | [Automation → Recipe Library](pkm-help:recipes) |
| 配置、共享、同步和后台工作 | [General & MCP](pkm-help:mcp)、[Sharing & Subscribe](pkm-help:subscriptions)、[GitHub Sync](pkm-help:githubSync)、[Background Tasks](pkm-help:backgroundTasks) |

只用你需要的部分即可。Project 用来组织工作，Note 用来保存知识，Todo Board 用来追踪承诺和验收；它们不是同一种东西。

### 研究资料和可复用工具：从哪里开始？

- **Research：**右键文件夹或 Group，选择 **New Paper…** 或 **New Idea…**。记录来源、结论，以及哪些仍是假设。
- **Prompts：**右键项目/任务/版本文件夹，选择 **New Prompt…**。用版本和对比追踪改进，不随手覆盖有用的基线。
- **Scripts：**右键文件夹，选择 **New Script…**。说明输入和预期输出，执行前审查代码与前提。
- **Packages：**使用 **Import Git**保存某个分支的源代码快照，不会安装依赖，也不证明代码已经能运行。
- **Environments / Servers：**登记本机真实存在的环境，启动服务前检查配置和状态。这些可执行资源需要运行前提，和不需要 Python 的基础笔记不同。

```agent
帮我处理 [一个研究问题，或经常使用的脚本/提示词流程]。
先找 PKM 中已有资料，建议合适的内容类型，再写一个小草稿，
包含来源、输入、预期输出和验证方法。区分证据与假设。
未经我确认，不运行代码、不安装依赖，也不覆盖已有版本。
```

## 3. 找到知识，把经验变成技能

内容搜索框搜索当前集合。知道资料在哪里时，给 Agent 复制好的 PKM 路径；不知道时，让它搜索，并解释为什么选择这些资料。

整理整个 Notes 目录时，让 Agent 使用 `list_notes(directory="目录路径", recursive=true, limit=0)` 返回全部匹配笔记。默认 `limit=50`，正整数指定返回上限，没有固定的最大值；所有调用都返回同一种带总数和分页信息的结构，不需要 `detail` 开关。也可以按 `next_offset` 继续分页，并带上第一页的 `inventory_revision`，直到下一页为空；期间目录变化会明确报错，需要重新盘点。检查 `identity_complete`：旧笔记缺少稳定 ID 或出现重复 ID 时会明确标记，列举本身不会修改笔记。这不等于已经支持安全目录迁移。

默认的 Exact/BM25 检索不用下载向量模型。[Router](pkm-help:skillRouter) 提供可选的语义检索及性能观察，等基础流程好用后再考虑调整。没有质量标注或耗时数据时，结果是**未知**，不是零，也不是已经证明更快。

**Skill（技能）**是一套可复用的做法：写清何时适用、前提、步骤、预期输出和验证方法。一次失败尝试里的猜测，不应直接变成“已经验证的经验”。

```agent
搜索 PKM 中关于 [主题] 的知识，读取最相关的资料并引用 PKM 路径。
把已经验证的方法整理成 Skill 草稿，包含适用场景、前提、
步骤、预期输出和验证方法。明确标出不确定的部分。
如果已有同类 Skill，先比较；替换前征求我的确认。
```

## 4. 怎样让 Agent 真正完成工作？

[PKM Chat](pkm-help:chat) 可以选择模型、上下文、工具和权限。外部 Copilot 或其他 Agent 也能通过 MCP 使用 PKM，但要先配置对应客户端并启用工具。

使用 VS Code 模型时，点击 **Choose Model** 先选择 **Copilot Models** 或 **SDK**，再选择该来源的模型。Copilot Models 只显示可用的 Copilot 模型；SDK 未登录时先通过 VS Code 的 GitHub 登录和账户授权，再显示 SDK 模型。两个列表都把来源提供的 **Auto** 放在第一项，显示全部可用模型，不混在一起。取消选择或登录不会更换当前模型，也不会发起模型请求。

在 Chat List 的用户分组（包括 Ungroup）上右键或打开省略号菜单，选择 **Copy Path**，可把 `pkm://chat-groups/<group ID>` 交给 lead Chat。Agent Sessions 中的同一用户分组也能复制此路径。lead 可按该路径分页列出分组成员，再按你的授权分配工作；复制路径本身不会启动任务。成员按实际保存的用户分组确定，不包含 Trash，也不因 Worker 临时显示在 manager 下而改变。

一个好指令包括：**目标 + 资料 + 允许修改的范围 + 交付物 + 验证方法 + 停止条件**。不用记住所有工具名，让 Agent 先发现可用工具、检查前提，再执行。

```agent
目标：[我想完成什么]。
上下文：[复制的 PKM 路径，以及相关文件]。
允许修改：[具体文件或条目]。不要修改：[范围外内容]。
交付：[笔记、补丁、对比结论或其他具体结果]。
验证：[测试、保存后的回读或可测量的标准]。
验证通过后停止；遇到阻塞时提交证据和原因。
未经我确认，不安装、不发布、不删除，也不修改权限。
```

查看 Chat 中的工具活动和实际结果，别只看最后一句“完成了”。工具调用成功不一定代表任务成功。取消时，一些操作可能已经发生：**重试前先检查记录**，尤其是写入、发布和远程提交。

模型调用可能产生费用。工具轮数上限不是耗时上限，也不是费用上限。先完成并保存一个小切片，通常比大范围探索后无法收尾更可靠。

## 5. 用 Todo Board 管任务和验收

在 [Notes](pkm-help:notes) 新建时选择 **Todo Board**。看板里的 Work Item 是结构化任务，包含目标、范围、验收标准、依赖、负责人和证据，并提供 Table / Board / Timeline 视图。

- 分配前先写清楚什么才算完成。
- 可以分配给自己、PKM Chat，或明确授权的外部 Worker。
- **分配任务不等于启动 Agent。**打开选中的聊天，明确要求它处理该任务。
- Worker 汇报结果和证据；**声明 Done 不等于已验收**，需要另外审查和接受。
- 外部 Worker 必须使用看板授权的操作工具。独立身份可能需要从界面复制 Board 专用 token。它是秘密凭据，不要贴进公开笔记。

打开 Work Item 查看任务约定和证据，**Accept**记录你的验收决定。外部 Worker 应先保存分配，再重新打开条目编辑器，使用可见的 **Copy / rotate external worker token**。复制 token 不代表可以扩大已分配的工作范围。

```agent
读取 Todo Board [复制的看板路径] 和 Work Item [ID]。
检查当前范围、依赖、负责人和验收标准。
如果我已授权且任务可领取，用 PKM 任务工具领取后只做这项工作。
记录验证和证据。不要直接编辑看板 Markdown/JSON，
不要领取其他 Agent 的任务，也不要自行把输出标成已验收。
```

## 6. Chat、Task、Worker 有什么区别？

**Chat**是持续对话；PKM Chat 中的 **Task** 为工作提供持久执行上下文，对应的 Agent Session 可在 [Automation → Agent Sessions](pkm-help:agentSessions) 查看。Agent Session 不等于 Todo Board 上的一条任务。

简单问题用普通聊天即可。较长的工作，在 PKM Chat 里明确创建或选择合适的 Task。外部 Agent 不能创建或管理仅属于 PKM Chat 的 Agent Session，但可以处理已授权的看板任务及其他可用 PKM 工具。

PKM Chat 的清单图标 **Start Task**进入托管任务的启动流程，先检查所选 Chat 的工具和权限。回复进行中，**New task**用于排队发送新请求，而不是引导当前请求；这个输入模式本身不等于托管 Agent Session。

**Worker**是负责独立工作片段的子 Chat。并行不一定更快或更便宜。写入范围应互不重叠，由父 Chat 完成共享构建、集成和最终验证。

```agent
只有工作片段真正独立时才拆成 Worker。
给每个 Worker 明确目标、资料、互不重叠的修改范围、
交付物、验证方法和停止条件。
共享构建和最终验收由父 Chat 负责。
不要让两个 Worker 修改同一文件，也不要不必要地继续递归派发。
```

## 7. Memory 和 Note 怎么选？

Note 是你能查看、整理和共享的知识文档。Memory 适合长期有效、范围明确的事实或惯例，不替代原始资料，也不代替任务看板。

使用明确的 Memory 工具时，说明适用范围和来源。外部 MCP 可以提出或读取 Memory，但明确的长期 Memory 确认需要对应的本地决策。不要以为说了“记住”就已经确认成功，也不要假设它会自动进入以后每轮提示词。

本地 PKM Chat 出现 Memory 决策提示时，审查并确认建议；外部工具的响应不能替你完成确认。

```agent
把这条已经验证的惯例作为 [本项目] 范围的 Memory 建议：
[惯例]。来源：[精确引用]。
添加前先检查是否已有等价内容，不保存秘密或个人数据。
告诉我它现在是待确认建议，还是已经确认的 Memory。
```

## 8. 什么时候用 Recipe 和 Action？

反复执行一个输入和输出都明确的稳定流程时，再使用 [Recipe Library](pkm-help:recipes)。Recipe 是可复用流程，run 是某一次执行。先看已有 Recipe 的用途、参数和附带知识，避免为同一件事重复造流程。

[Action Library](pkm-help:actionLibrary) 和 [Action Workbench](pkm-help:actions) 用于可复用 Action 及其执行。脚本、Pipeline、环境和外部 CLI 工具仍需要依赖、身份认证和执行授权。

```agent
我经常需要执行 [流程]。先搜索 PKM Recipe Library。
比较已有 Recipe 与我的输入 [输入]、预期结果 [输出]。
优先复用或小幅扩展，找不到合适的才提议新建。
运行前解释前提、可能产生的修改、需要审批的环节和验证方式。
```

System Recipe 是受保护的内置流程，不是可以随手覆盖的个人文件。执行前验证流程。保存成功、图画得完整，都不代表实际运行已经成功。

## 9. 组织项目、讨论和协作

[Projects](pkm-help:projects) 组织较长期的工作。[Threads](pkm-help:chatroom) 保存关联讨论，项目的 Timeline/Gantt 展示计划日期和观察到的进度。

协作时写清主要执行者、预期输出、当前上下文、Reviewer 和最终决策。进展更新、交接、完成声明、审查结论不是同一件事。遇到阻塞时说明原因，别只不断互相说“继续”。

```agent
针对 Project [名字]，把 [目标] 整理成少量具体任务。
为每项提出主要负责人、范围、依赖、输出、验收标准和 Reviewer。
关联已有笔记和 Thread。未经我确认，不分配给他人，也不启动 Agent。
```

## 10. 共享知识，不是公开所有内容

[Sharing & Subscribe](pkm-help:subscriptions) 用来共享选中的知识，或订阅 Broker 的资料而不合并到自己的集合。[GitHub Sync](pkm-help:githubSync) 用于明确选择的发布、同步和备份目标。[Portal Connections](pkm-help:portalConnections) 连接受支持的 Portal 使用场景。

GitHub Sync 的当前进度与历史结果分开显示：`Queued` 表示正在等待同步 worker，只有 worker 报告后才显示 Git lock、Fetch / Pull 等具体阶段。如果同步正在运行但阶段信息缺失，会明确提示 phase details unavailable，并显示当前状态节点，不会猜测已完成哪些步骤。新一轮排队或同步期间隐藏旧的成功提示；结束后的成功提示标为 `Last sync completed successfully`，表示上次结果。

发布前检查公开/私有设置。拥有 Git 仓库访问权的人能读取已提交内容和历史；PKM 的发布选择不是 Git 读者的逐文件权限控制。浏览器私有内容和访客访问也有各自的边界。

```agent
为 [选中的 PKM 条目] 准备共享方案。
列出目标、包含的内容和附件、隐私设置、访问边界。
检查凭据和私有资料。在我审查并确认前，不发布、不 push、
不创建邀请，也不改变访问权限。
```

邀请、Magic Link 和 Worker token 可能授予访问权限，不要放进公开知识、截图或提交历史。

## 11. 用 Agent Snapshot 接续工作

打开 [Agent Snapshot](pkm-help:agentSnapshots)，选择 PKM Chat Task 并创建快照，保存捕获到的任务状态。**Copy Read Prompt**提供读取快照的指令，不创建新 Session；**Recover into New PKM Chat**是另外的恢复入口。

复制的指令只是要求读取，不会改变 Agent 的权限，也不禁止其他已启用工具写入。只做检查时，应同时限制请求范围和工具权限为只读。

```agent
读取已有 PKM Snapshot：[粘贴 Copy Read Prompt 提供的信息]。
总结目标、已完成工作、阻塞和未完成验证。
继续前先检查当前文件和结果。不要因为聊天停止，
就重放此前的写入、发布或远程提交。
```

Snapshot 不是所有文件的完整备份。它的记录和内容仍需存在于本地，或从明确选中的备份恢复。GitHub Sync 的 Snapshot 备份默认没有开启。快照内容的混淆不是抗攻击加密，不要把它当成秘密保险箱。

## 12. 需要 AI 集成时，再配置 MCP

打开 [General & MCP](pkm-help:mcp)，或直接 [选择 Python](pkm-help:setup)。

1. 选择 Python 3.10+ 基础解释器：List Pythons 或 Browse，然后 Validate & Save。
2. PKM 自动创建隔离的 `pkm-mcp` 环境、安装包、生成服务并检查健康状态。查看真实阶段和输出。
3. 配置**你实际使用的客户端**，确认工具发现，并在那个客户端实际调用 `check_version`。

VS Code 项目解释器与 PKM 基础 Python 是两种选择。Remote SSH 应使用远程主机的 Python；远程 Linux 的配置不会自动配置 Windows 本地客户端。

VS Code 原生 Agent 的工具发现与 Copilot CLI/SDK 注册是分开的。同一个客户端不要重复注册服务。保存注册不等于授予信任、启动服务或确认工具可见。Runtime ready、检索已调度、客户端已验证是不同状态。

```agent
诊断为什么这个客户端不能使用 PKM MCP。
确认真实主机和客户端、Python、托管运行环境、注册、
信任/启动状态，以及是否能发现 check_version。
指出第一个阻塞步骤和最小安全操作。
未经我确认，不修改注册、不安装包、不改变权限，也不停止进程。
```

找不到 Python 时，在目标主机安装 Python 3.10+ 后重新扫描。包下载失败应有错误详情和重试入口。“稍后继续”是延后配置，不是配置完成。

## 13. 卡住、变慢或失败时怎么办？

问题提示提供对应的下一步操作，以及指南相关章节的入口。打开说明不会安装、
删除、发布或重新发送 Agent 请求。配置和环境警告在检测到健康状态后清除；
打开指南或关闭错误提示不代表修复成功。

- **组件缺失或 MCP 环境损坏？**查看服务配置或环境修复。选择有效的基础 Python，阅读失败阶段和输出，检查活动客户端，再使用明确的 Create/Repair 操作。
  打开 MCP 设置页和刷新状态只进行检查，不启动安装、不重试维护。明确修改 Python / 配置之后的已有自动准备流程不变。
- **普通环境找不到？**在 Environments 的问题摘要里点击**查看环境名称**，展开并定位对应登记项。重新检查当前主机上的文件夹和解释器；位置变了就登记正确文件夹，不要用 MCP Repair 修复无关环境。
- **包列表或版本检查失败？**查看错误，不要把它当成零个包。重新检查只读取状态，不安装包、不删除环境。
- **模型准备失败？**查看模型 Python、失败阶段和资源预算。重新检查模型状态不会重新下载权重；没有向量模型时仍可用 Exact + BM25。
- **Host 断开或界面失败？**连接失败用 Reconnect，资源加载失败用 Reload interface。查看诊断日志；这些操作不会撤销此前工具的执行。

- **还在准备？**查看 [Background Tasks](pkm-help:backgroundTasks) 中真实的后台工作，再看对应页面的输出。
- **Agent 停止？**先检查工具记录和已保存改动，不要盲目重新发送会修改状态的请求。
- **环境修复要求操作？**按共享客户端的 drain/reconnect 提示处理，不杀无关进程，不绕过保护。
- **同步冲突？**查看两个版本和该目标的诊断信息，再决定如何合并。
- **没找到知识？**先核对来源、精确路径、权限及资料是否存在。不要把下载向量模型当成第一步。

```agent
调查 [问题]，先不修改配置。
使用当前错误、相关日志和工具记录，区分事实与假设。
解释可能的阻塞及一个安全的下一步，明确还未验证什么。
```

提交有用的反馈时，写明做了什么、预期和实际结果、扩展版本、本地/远程主机、错误文本及不含秘密的诊断。不要附上凭据、邀请链接或私有知识。

## 14. 用一条简单的习惯逐步扩展

**记录 → 整理 → 委派 → 验证 → 复用。**

先用笔记保存知识，用 Skill 固化已经验证的方法。给 Agent 精确资料和有边界的目标，检查输出后再验收。确实需要追踪、多次复用、并行、共享或恢复时，再使用 Board、Recipe、Worker 和 Snapshot。

PKM 不会让未知结论自动变真，不会取消审批，也不是每件事都自动执行。修改、运行、分享和验收的控制权仍在你手里。

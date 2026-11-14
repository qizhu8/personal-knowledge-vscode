# PKM Retrieval 专项研究任务

记录时间：2026-10-10。交接基线：3.2.19。
状态：待独立 agent 研究；此文档不表示尚未实现的机制已完成。

## 任务目标

研究如何让整个 PKM 的 retrieval 系统可独立开发、替换和升级，并提升
PKM Chat Memory 的证据相关性、精细定位和预算利用率。

用户最初观察到 Memory 检索出大量无意义内容，挤满约 100K 字符，
并询问该限制的来源。用户认可现有 Memory UI，希望保留其可观察性，
而不是通过关闭 History、隐藏证据或扩大固定字符上限绕过问题。

**先研究并提交有证据的设计和实施计划，不默认开展全面重写。**
区分 retrieval 质量、协议正确性、上下文选择、存储和运行故障，
不要把它们归为一个“换模型即可解决”的问题。

## 已确定的设计约束

- 通用标准面向以后所有接入 PKM 的 retrieval 系统，而不只服务 Chat。
- **L1：文件/资源级检索**，选择 Knowledge、Skill、Note、Recipe、
  Action、Script 等可寻址来源。
- **L2：内容级检索**，选择 Memory piece、History piece、
  tool evidence，或对 L1 来源的段落、表格、代码段二次精细定位。
- L1、L2 可以使用不同模型、索引、进程及发布节奏。
- Provider 返回候选和实际 serving 身份；Consumer 负责权限、版本验证、
  预算、最终选择及发送回执。分数不能决定权限。
- 不同检索方法的原始分数不能直接混排；融合策略和 fallback 必须可解释。
- 先检索和选择，再测量所选子集是否超预算；只有不适配时才触发 refinement。
- 优先可复现的结构化/抽取式定位，不默认 LLM 改写、模型下载或训练采集。
- 原始证据不应因裁剪、失败、取消或派生索引更新被破坏。

标准基线见 [PKM Retrieval Standard](./pkm-retrieval-standard.md)。
研究中发现标准不完整或实现未迁移时，应明确列出，不将文档当成实现证据。

## 已实现与尚未实现

### 已验证的基线

- 原来八个失败回归已修复；它们不是当前仍待修复的八个失败。
- 移除了与模型窗口无关的 100,000 字符请求守卫。
  当前还有各自用途不同的存储、资源、候选和内容边界，不能一并删除。
- 完成/失败的工具结果可以作为独立证据；失败、取消、中断回复不再
  使已完成工具证据全部丢失。
- 自动引用在每轮请求预算中可被排除；必需指令、当前输入、固定上下文、
  活跃工具 call/result 配对不能被静默裁掉。
- 已有有限候选验证、异常/超时隔离，以及区分 recall 与实际 sent context
  的 Memory/检索时间线 UI。
- 合成回归的历史重放为 128,941 字符，目标证据引用为 273 字符，
  能在 8K 窗口下发送且保留原始磁盘证据。**这是合成正确性验证，
  不是实际 retrieval 质量基准。**
- 3.2.19 联合上下文/Worker 测试为 41 个可执行通过、0 失败、
  18 个 retrieval 机制 TODO。Worker 测试通过不能替代 retrieval E2E。

### 当前需要研究的缺口

- 自动、结构感知的 L2 refinement 和重新检索闭环。
- 学习型 Memory ranking、跨来源融合和证据覆盖策略。
- 独立持久 source blobs、索引/manifest 发布恢复和证据生命周期。
- feedback opt-in、来源/版本 lineage、离线评估及升级准入。
- 真实 retrieval worker 到最终 materialization 的新上下文流水线 E2E。
- 实际安装 Extension Host 的 retrieval 执行 E2E。

当前实现的具体观察：Chat knowledge 路径最多接收 20 个候选，
尝试使用前 3 个有内容的候选，超过 4,000 字符的来源明确跳过并标记
需要 L2；这不是自动精细定位。现有预算函数按 priority 逐个容纳自动引用，
不是完整的证据条件规划器。请评估这些策略的影响，不直接假定固定数量
或长度阈值适合所有模型和任务。

## 研究问题与交付物

1. **现状调用链**
   - 梳理 Chat Memory/History/tool evidence、PKM corpus、L1/L2、
     provider、worker、最终模型请求和 UI 回执之间的实际路径。
   - 标明哪些标准字段已经实现、哪些只是接口、哪些 consumer 尚未迁移。
2. **问题归因与可复现实验**
   - 区分 recall 不足、排序无关、重复证据、错误粒度、
     stale 来源、过度近期偏置、预算排除和必需上下文本身过大。
   - 使用合成或明确授权的本地样本；给出具体 query、候选、选择、
     发送 payload 和失败原因，不凭模型答案看起来正确判断成功。
3. **候选方案比较**
   - 比较当前规则/词法、BM25、dense/sparse、reranker、fusion，
     以及结构化 splitter 与抽取式 L2。
   - 说明质量、延迟、CPU/内存、索引成本、隐私、部署和升级代价。
     不预设必须采购远端模型或引入某个框架。
4. **标准与架构补全**
   - 能力协商、immutable identity/range、权限范围、serving 版本、
     explicit fallback、generation、deadline/cancel 和完整 selection receipt。
   - 可独立替换 L1 或 L2；迁移保持现有消费者兼容。
5. **闭环与预算设计**
   - selection → 实测 budget → refinement/re-retrieval → reselection。
   - 明确 fit、无进展、尝试/时间/资源上限、不可用和取消的停止条件。
   - 保留否定、单位、实体、表头、数值与共享测试条件；
     不把压缩、切片和 LLM 重写混为一个机制。
6. **评估与分阶段实施计划**
   - 提交覆盖所有 M01–M18 的对应方案、风险和实施顺序。
   - 给出质量与性能指标、基线、拟定通过阈值和升级回滚条件；
     先报告实测基线，再说明阈值依据，不编造改善幅度。
   - 最终输出：现状图、根因证据、方案比较、推荐设计、
     标准差距、分阶段任务及验收计划。

## 18 个未完成机制的权威清单

详见 [Chat Context Test Cases](../../tests/cases/CHAT_CONTEXT_TEST_CASES.md)
中的 M01–M18 与实际 [上下文测试](../../tests/test-chat-context-contracts.js)。

覆盖：预算边界不多做工作；超预算后 refinement；首次 fit 即停止；
重复检索无进展；有界停止；JSON/表格保真；未知文本非破坏性处理；
LLM fallback 单独授权；源版本失效；稳定 children/ranges；
每轮重规划；steering 恰好消费一次；retry/delegation 作用域；
最终回执对齐 payload；实际 serving/fallback 归因；
关闭反馈不采集；存储发布崩溃恢复；真实安装 Host/browser E2E。

部分基础断言与这些条目重叠，但不能因此直接移除 TODO：
只有对应生产机制及正/负触发、调用顺序、边界和停止测试都落地后，
才可将该 TODO 替换为可执行验收。

## 代码入口与已有验证命令

- [通用 contracts](../../src/retrieval/retrieval-contracts.ts)
  和 [provider 接口](../../src/retrieval/retrieval-provider.ts)。
- [TypeScript worker](../../src/retrieval/retrieval-worker.ts)
  和 [Python serving worker](../../resources/retrieval_worker.py)。
- [Chat Memory](../../src/chat/chat-memory.ts)、
  [Chat retrieval](../../src/chat/chat-retrieval.ts)、
  [上下文选择](../../src/chat/chat-context.ts)、
  [Chat controller](../../src/chat/api-chat-view.ts)。
- [Chat 文档](../api-chat.md)。

```sh
npm run build
node --test tests/test-chat-context-contracts.js
node tests/test-api-chat.js
node tests/test-retrieval-contracts.js
python tests/test-retrieval-serving-worker.py
```

根据研究范围选择最小测试集合。既有 worker/browser 回归不能冒充新的
真实 provider → source materialization → model payload 的端到端测试。

## 工作边界

- 此任务不包括 Worker 状态机、配额或 Chat 分组重写。
- 用户于 2026-10-12 确认此前崩溃属于 VS Code 问题；不再作为 PKM
  或 retrieval 待办跟踪。保留已有活动中断汇报与证据保存机制，
  不继续调查该崩溃根因。
- 当前工作树包含大量既有未提交变更。先检查状态，不回滚、不覆盖，
  不默认提交、安装、重载窗口或打断真实 Chat。
- 不唤醒、停止或修改之前 review 的真实 Manager/Workers 来测试。
- 不向外部服务发送私有 corpus、聊天、query、凭据或代码；
  不默认开启训练、遥测、模型下载或付费请求。
- 研究过程发现需用户决定的模型、隐私、行为或范围选择时，先取得确认。

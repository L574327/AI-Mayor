# HANDOFF-CODEX — AI Mayor 交接入口（2026-10-02，取代此前所有 HANDOFF）

> **最新进展与已有能力索引见 HANDOFF-2026-10-03-DISTRICT-BUILDER.md 第十九至二十一节（2026-10-04）。先读那里再动手，避免重造已有机制。**

> 接手者先读这一页，再按 §6 的清单取文档。**本文只写"现在为真的事"**，每条都标明**适用世界**；
> 旧世界的距离/覆盖结论一律作废，见 `DOC-INVENTORY.md` 的过期章节表。

## 1. 产品目标（用户原话，最高优先级）

本地自治是**最终默认形态**；云端 AI 只把自然语言翻译成结构化意图，本地精确执行。
**游戏世界是唯一权威**：读世界 → 照常扩张；游戏自带防呆（overlap / 节点占用 / 409）就是重复建设的保护，不另设对账层。
成品要横平成街区、层级分明、有变化；**验收看世界读回，不看 journal 增长**。
新原语一律"读世界 + 幂等"；游戏拒绝 → 记录并继续。回滚 = 玩家 Load 旧档，产品重读世界，不要求账本与存档逐条配对。

## 2. 三栏（每条标适用世界）

**已证实**（世界 = 斯奈德维尔，generation `ff472a1098e24131b052079ecbea57a2`，除注明外；
本页所有"实测"数字都只有在**这个世界**成立，换档即作废）

- **Load 即 re-baseline**：未登记存档被 Load 时不再 quarantine；继承的 authority 与 **plan** 一起退休，加载档成为新回滚边界。（实测：`docs/ai-mayor/evidence/load-rebaseline-acceptance-2026-10-02.json`）
- **PLACEHOLDER 的 projectState 与任何非空 plan 不能共存**：共存会让每个 tick 抛 `GOAL_WORK_ORDER_ACTIVE_SCOPE_CHANGED`、journal 永久冻结（163 条陈旧 work order 实测）。
- **一条线一段 + 两端自由提交**：显式写 `NEW_FREE_ENDPOINT` 给 START 会被拒；**省略 startEndpoint** 世界答 CERTIFIED。折回判据是射线（从节点出发、航向与某条离点街道同射线），**与长度无关**。
- **道路连通 = 分量**：新路不与既有路成路口就是**独立分量**。本轮实测：8 条提议里 1 条自建孤岛（40 m 桩），已按"换节点对 + 只读预检"接回（直连被拒、轴向 elbow 被认证）。
- **走廊（P4）可绕水**：`planRoadCorridor` 单次从主网搜不到目标时，**经自由带路点分两段**可以；本轮 4 跳把 66 街新区接进主网，全图 1 分量。
- **水/污服务覆盖 94%**（本轮新区 31 栋）：就近放设施 + 连到本区街道即生效。
- **低压地缆不能当"拉电"手段**：沿街铺 11 条后覆盖 48% → **13%**（与旧世界 §8a 同向）。
- **覆盖率的分母只能是"有 consumer 组件的建筑"**：`consumerService.* === null` 是空壳（未落成），不是未接线。
  按此读法，**东群岛 25/25 与主城 28/28 三网 ≥96%，一写未做**。之前几轮的"电 0%/13%/48%"是分母被空壳污染的假读数。
- **人口一律读 `/city/statistics?type=Population`（时间序列）**，不要用 `/city/overview.population` 的单次读数：
  本轮后者在 Load 后片刻读到 643，而序列从头到尾都是 47–50，属误读。
- **正式 Mayor 能持续扩张**（2026-10-03 实测，10 tick，`AI_MAYOR_LIVE_TICKS=10`）：
  自动 re-baseline（journal 240→5）→ 立项 → 交路 → zoning，**13 条路 + 8 次 zoning**，
  全部落在**同一个分量**内并向外推进（岛 56→**75 街** / 2574→3551 m），新带 34 栋真实消费者 **三网 100%**，
  跑完 session 仍 `RUNNING` 无错。搜索锚点来自 `selectGrowableSearchAnchors`（自建路端点按度数升序 = 前沿尖端）。
- **吞吐的真实瓶颈是"为了一个点重读整个世界"**（2026-10-02 实测，插桩归因到调用点）：
  一个**零写入**的 blocked tick 里做了 **162 次完整观测**，每次 = `cs2_game_state`×2 + `cs2_mayor_snapshot` + 全量
  `cs2_spatial scan` + `cs2_spatial detail`。三 tick 共 **133.8 s** 桥往返，其中 scan 45.5 s、detail 51.0 s ——
  而这 162 次 scan 与 snapshot **全部被调用方丢弃**（它只读 `sources.spatialDetail`）。
  修法：`capture()` 新增 `globalSources`（**这次调用真正会读的全局源**；不传 = 全读，既有调用点逐字不变；
  声明不读的源**不读、报 `UNAVAILABLE/NOT_REQUESTED`、不参与 coherence** ——没人读的源不该让观测变成 UNKNOWN）。
  实测：`scan` 345→58 次（45.5→6.8 s）、`snapshot` 356→94 次（17.1→3.1 s）、
  **三 tick 桥往返 133.8→61.4 s**；同决策同 anchor 预算（160 vs 162 次 detail）的等价对比 **墙钟 39.4→22.0 s**。
  `MAXIMUM_STARTER_ANCHORS = 48`，所以 150 次 detail/tick 就是 anchor 预算本身，**不是**放大。
- **一处等待不再冻结全城**：`wakeNeedsTheWorldToRun` / `waitsOnDependentConstruction`（`runtime.ts`）。
- **修好假停摆后，正式 Mayor 首次自然跑完长会话**（2026-10-02，`tmp/longrun-migration.json`）：
  20 tick / 22.6 min / **`session.status = RUNNING` 无错**（此前必在第 11 窗 halt）。产出 7 条路 + 28 次 zoning。
  世界读回：总路网 469→**479 街**；**东群岛 93→103 街，前沿 z[66..704] → z[66..740]**（向南推进）；
  主城 375 街未动；孤立格网行仍是 1 街。**它没有停死，但也没有跨区域迁移**——
  因为那座岛当时还有地方可建，判据尚未被触发。
- **"同一块地反复死"对非 EXPAND_\* 目标不被记住**（下一步的要害，2026-10-02 定位）：
  20 tick 里有 **6 窗零写入**，全部是同一个循环——生长策略选 `PROVIDE_SERVICE:electricity`
  → `GROWTH_POLICY_ADMITTED` → 道路步骤在**同一节点 `233538:1:end`** 被 native 拒
  → 下一窗换一个新 facts 指纹**重新立项** → 再死在同一处；第 3 窗才 `GROWTH_POLICY_DOMAIN_SWITCH` 走开。
  机制：admission 成功后才死的目标没有 TARGET park；唯一能记住它的
  `runtime.ts:goalOrderUnservableRoadTarget` 的正则是 `^(EXPAND_RESIDENTIAL|EXPAND_COMMERCIAL|EXPAND_INDUSTRIAL|EXPAND_OFFICE):…`
  —— **非 EXPAND 族匹配不上，永不 park**。（TARGET park 只在 admission 抛
  `V2GrowableFootprintUnserviceableError` 时创建，见 `runtime.ts:1562`。）
- **`RUN_STALLED_NO_WORLD_EFFECT` 曾经是假停摆，会把正在施工的 Mayor 停掉**（2026-10-02 查清并修复）：
  ledger 的停摆文案承诺了"population / building / applied-effect / **progression**"四项，`cityChanged` **只实现了前三项**。
  而 V2 Brain 分支（`runtime.ts` 的 local 分支经 `#finishTick` 返回）**一个 telemetry 效果计数都不填**，
  `zonedCellCount` 全树没有写入方 —— 于是 `applied` 恒为 `{0,0,0}`。
  实测 `tmp/expansion-vertical2.json`：11 个窗口建了 **9 条路 + 14 次 zoning**、几乎每窗都新立一个 Goal，
  却因为该城人口长期 46、其余三项全钉死，第 11 窗被 `#halt()`。
  **修法**：`planAdvanced` 读文案本来承诺的第四项（active work order 的 goalId/status/stage 对上窗比较），
  `classifyRunProgress` 接收上一窗的 decision。**看门狗没有被削弱**——plan 也没动的那一窗照样计数、照样触发（有测试）。
- `runSimulation` 以 **1 s 间隔**轮询 `cs2_game_state` 等时钟推进，一轮 180 s 里有 **96 s** 花在这里 ——
  这是**在等游戏**，不是浪费（改后那轮真的在建东西所以等得多）。

**待证**

- **`DEFAULT_SERVICE_REACH_METERS` 该取多少**：其原依据（欧氏 325 m ⇒ 0%）已被证伪为测量错误（分母含空壳）。
  **暂不改动**，等有正确分母的重测数据；**图距 vs 欧氏仍无法区分**。
- 电在本世界的真实注入点（外部连接？主网哪一段？）：**未定**。已确证的是本地 3 台风机全部未接入路网，而覆盖仍 100%。
- `cs2_place_building` 在 12 个偏移里只有 1 个被接受（其余返回状态不明）——放置失败面未定。
- **换到第二片"独立"区域**：只证到"在同一分量内连续找新机会"，**没有观察到一次跨成分/跨区域的搬迁**。
  （当前世界本就有 MAIN + 东群岛两个分量，锚点列表里两组都出现过，但没有一次真的搬过去。）
  更正：16 tick 那轮第 11 窗的 `RUN_STALLED_NO_WORLD_EFFECT` **已查明是假停摆**（见下条），
  那次"停在原地"是**被产品自己 halt 掉的**，不是"找不到下一片所以停下"。修好之后 20 tick 自然跑完、
  仍全在岛上——所以"找不到下一片"这一条**至今没有任何一次真实观测**，既没被证实也没被证伪。
- 那条 409 的访问课程段（`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`）成因未读。
- 桥的 `CreateDefinitions` 会被"失焦暂停"永久攥住锁（见 `UTILITY-SITING-CONSTRAINTS.md` §11）；Load **不清**它，须**重启游戏**。

**已作废**

- 血缘确认 / `projectAuthority` 重构 / pending-descendant 机件（代码与测试已删；类型与加载白名单保留只为旧档能打开）。
- 旧世界（generation `1e53914edf…`）的一切距离与覆盖数字：569 m→18/18、611/1145、1028/1631、600 m 规则、"排污口必须临水"、"本区 600 m 内无水体"、"同分量即服务"。**这些只在那个世界成立，本世界已实测反例。**

## 3. 已接线 vs 仅纯函数/脚本

| 能力 | 状态 |
|---|---|
| 集合格网（`planGridCollections` / `planRectangularGrid` / `filterGridSegmentsByTerrain`） | **已接线**：`gate1-progression-boundary.ts` 的 `buildRoadGridCandidates` |
| 两端自由提交 | **已接线**：`road-grid-generator` 的 `RoadGeometryInput`（省略 startEndpoint） |
| 同一分量验收 | **已接线**：`selectCollectionSite`（`mainComponentRoot`）|
| **scope 可达性并入 `issueActive`** | **已接线**（本轮）：`utility-service-reach.ts:scopeNeedsService` → `main-adapter.ts:asCapacity` |
| **按需读世界（`capture({globalSources})`）** | **已接线**：`foundation.ts`；4 个"只读一个点"的调用点已声明（Gate1 每 anchor detail、admission 的 `captureSiteDetail`/`readReservation`、scope 内住宅普查）|
| 一处等待不冻结全城（`wakeNeedsTheWorldToRun`） | **已接线**：`runtime.ts` |
| 就近补设施（放 + 连） | **已接线**（走既有 `plan()/execute()`）；脚本版见 `scripts/tmp-place-facility.ts` |
| `serviceReachByNet` / `netsMissingService` | 纯函数；一个已接（上表第 4 行），`netsMissingService` 仅脚本用 |
| P4 走廊（`planRoadCorridor`） | 产品用于 admission；本轮"分两段绕水"只在脚本里 |
| zoning 半径 epsilon 修复 | **已接线**：`gate1-progression-boundary.ts` |
| 链条脚本 | `scripts/tmp-expansion-chain-live.ts`（选址→铺路→reach→补设施→zoning→模拟→普查→截图） |

## 4. 当前世界与回滚点

- 世界：`cs2-session:d8413e4f61f54d2296ac75149befb534`，generation `ff472a1098e24131b052079ecbea57a2`
  （**斯奈德维尔**，玩家重启游戏后 Load 的「斯奈德维尔 5」）。
  ⚠️ **不要从 `/city/overview.population` 读人口**：本轮它在 Load 后片刻读到 643，而时间序列从头到尾都是 46–50。
- 路网（2026-10-02 长跑后读回）：**3 个分量 / 479 街 / 56,472 m** ——
  MAIN `233552`（375 街 / 51,672 m，全程未被动过）、**东群岛 `233557`（103 街 / 4,680 m，x[663..1529] z[66..740]）**、
  以及**一条尚未接上的格网行** `236313`（1 条 Medium Road / 120 m，x[1209..1329] z=626）。
  该行落在岛的 40 m 格网线上（z 545.77→585.77→**625.77**），是"先铺行、后连横向"的前沿形态；
  **产品 Gate1 道路路径里没有"必须同分量"的硬门**（那只是一种测量纪律），且提交仍走同一条 native 预检 + `cs2_build_road`。
- 账本：分支 `62e4e251f5497872673213c0c4fc9bb16ed0808a`；Load 后按 re-baseline 语义重读世界。
- 回滚点：**`save:7dd68a23b59fef9fe83d648d21ab2e6b:7e971ee42c0dbe63efdf37b1a092ec65`**（「斯奈德维尔 5」，账本的 baseline）。回滚 = 玩家再 Load 该档。
- 桥运行纪元：`29cb2e75638144168c0e74b3fa613755`（游戏重启后）。**写之前先只读确认 `nativeOperationBusy === false`。**
- 城市读数（2026-10-02，frame 11960117，游戏时间 2026-01-12 12:02）：人口 **47–48**（时间序列）、建筑 112；
  电 production 22,876 / consumption ~10,700、水 capacity ~29,200、污 capacity 200,000。
- 仓库：分支 `feat/ai-mayor-road-debug`，长跑后工作树干净；`docs/ai-mayor/evidence/` 与 `tmp/` 下有 **1561 个未跟踪文件**（全是逐轮证据/临时脚本，未入库）。

## 5. 下一步（≤3 件，含验收标准）

1. **建设机会发现 / 跨区域迁移（当前主线）**。验收（看真实行为，不看单测）：
   **一个区域无法继续有效建设后，正式 Mayor 能自行找到另一片合理可建设区域并恢复成片扩张，而不是停死。**
   已排除的前置障碍：假停摆（见 §2）。约束：不预设实现；当前大量局部 anchor/detail 搜索只是**现状约束**
   （顺带减少无意义读放大是加分，但不为性能偏离产品行为）；必须兼容小空隙填补、城市边缘扩张、远处大片土地、
   桥梁/跨障碍、购地、不同街区尺度，**不把当前搜索方式固化成全局规则**。
2. **吞吐已收口**：`capture({globalSources})` 拿到实质收益（见 §2 与 §3 表），
   **不再为 RPC 数字继续优化 `cs2_spatial#detail`** —— 再削它会直接改变选址策略。
3. （挂起）只读定位电的投送机制。验收：给出该用欧氏还是图距、阈值多少的**可执行判据**。

## 6. 铁律

- 写世界前先只读确认 `world.nativeOperationBusy === false`；**禁止用写接口探活**；临时脚本写操作**单条提交→读回落定→再发**，响应含糊即视为未落定并停下（桥侧弱点见 `UTILITY-SITING-CONSTRAINTS.md` §11）。
- **先检索再造**：动手前先 grep/读现有入口，重复的编排层一律不加。
- **只补原语，不加控制规则**；不新增 controller / 状态机 / 平行执行路径；不给 `V2Gate1Progression` 加方法；不新增 `MayorRuntimePorts`。
- **不动 `durability.ts`**（除非用户明确裁决）；不动授权（finance）/ Apply-once / readback matcher。
- 每轮汇报必须含：**净增删行数、失去权力的旧 Authority、复用函数、无法确认项**；无法确认的**不猜**。
- 长跑脚本不要走 `| Select-Object -Last N`；MCP server 必须是 `cities-skylines-2-mcp-reconstruction`（59 工具），`-master` 缺 `cs2_read_blocking_modal`。

## 7. 蓝图与"待完成要求"在哪（入口页此前**没有**指向它们）

仓库里存在**两套互不引用的文档体系**。本页与 `DOC-INVENTORY.md` 只覆盖 `docs/ai-mayor/`；
仓库根另有 8 份 `AI_MAYOR_*.md`（2026-09-12 ~ 09-29），**既未被列入本节任何一栏，也未被标"已过期"**。

**承载"蓝图/设计"的**（都缺本页的过期标记，请自行判断时效）：

| 文档 | 行数 | 自述 | 与现状的关系 |
|---|---|---|---|
| `docs/ai-mayor/PRODUCT_NORTH_STAR.md` | 339 | 产品目标 + 最终架构 + **26 条不变量** + Definition of done | 本页列为"有效"。内含若干**明写"未实现"**的项（见下） |
| `docs/ai-mayor/V2_ARCHITECTURE_BASELINE.md` | 124 | 自述 **"CURRENT ARCHITECTURE AUTHORITY"** | ⚠️ **内部阶段描述已与现状矛盾**：写着 "Do not begin V2 planner implementation yet"、"Gate 1 is not yet runtime-certified"、Gate 2 待做；而实测 Mayor 已在持续扩张 |
| `docs/ai-mayor/URBAN_DESIGN_LANGUAGE.md` | 606 | 城市设计语言，2026-09-11 **FEATURE-FROZEN FOR ALPHA** | 含明确 deferred 清单（§16 环岛/radial、transit、主题等；§17 Phase 0–6 实现计划未实现） |
| `docs/ai-mayor/AI_MAYOR_GAMEPLAY_POLICY_SKILL_BIBLE_FROZEN.md` | 1323 | 玩法政策与 skill 圣经，2026-09-30 FROZEN | 17 个 Skill（S01–S17）+ 15 条 domain policy + §8 **缺口声明表**（8.1–8.10） |
| `AI_MAYOR_V2_CONTROL_PLANE_MIGRATION_BLUEPRINT.md`（**仓库根**） | 562 | 生产控制面迁移蓝图；§25 = 2026-09-29 | ⚠️ **与 §6 铁律直接对撞**：它主张"Brain 成为唯一顶层调度器"并新增 `DecisionAuthority`/`DecisionToken`/`ExecutionContextAdapter` 等（均标 proposed），而铁律写明"不新增 controller / 状态机 / 平行执行路径" |
| `AI_MAYOR_PRODUCT_NORTH_STAR.md`（**仓库根**） | 141 | 自述 supplement | 自认权威入口是 `docs/ai-mayor/PRODUCT_NORTH_STAR.md` |
| `AI_MAYOR_VOICE_BIBLE_V1.md`（**仓库根**） | 241 | 产品语言人格设计 | 无对应文档 |

**最接近"待完成要求清单"的**：

- `docs/ai-mayor/CAPABILITY-GAP-2026-10-02.md`（81 行）——**最像 to-do 的一份**。A–R 逐项列缺口，
  自述结论："**'风格惊艳'缺 5 项（B/C/D/E/F），'自治'缺 2 项（G/H）**"。
  其中 B（密度与资产选择）被点名为"碎块感"头号来源；F = 服务设施（学校/医院/消防/警局/公园）放置；
  G = 拆除（产品路径缺失，`skill.ts:27` 明写 "Never demolish"）；Q = `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` 设计级冲突。
- `docs/ai-mayor/EXPANSION-PACKAGE-MINIMAL-SLICE.md`（75 行）——未实现的"一个包=路+管线+zoning 同批交付"，含验收（三网 ≥80%）。
- `docs/ai-mayor/REMOVABLE-DURABLE-GATES-2026-10-02.md`（88 行）——待裁决清单；**第 3 条（市长不擅自存玩家的城）未摘、仍是承诺**。
- `PRODUCT_NORTH_STAR.md` 内明写"本轮故意不实现"的：`FORCED_SAVE_ON_STOP`（`stop()`→`#finalize()` 无条件 `save()`）、
  `ZONING` 执行、一次性 recovery resolvers 未接线。

⚠️ **已知的互相矛盾（交班时必须知道）**：

1. **谁是"当前状态入口"**：仓库根 `AI_MAYOR_DOCUMENT_MAP.md`（2026-09-22）指
   `IMPLEMENTATION_STATUS.md` / `NEXT_SESSION.md` 为"当前状态/交接主入口"；
   而本页与 `DOC-INVENTORY.md` 把这两份列为**禁读/作废**。
2. **当前阶段与世界**：仓库根 `AI_MAYOR_HANDOFF.md` 说处于 "Gate 1 / Phase B Electricity direct-cable
   runtime certification"、要 Load `AI市长V2-电缆前标准存档-0915-2252`；本页说世界是「斯奈德维尔」、
   主线是跨区域迁移。**两者说的不是同一世界、不是同一主线。**
3. **治理姿态**：迁移蓝图要新增调度层，铁律禁止。
4. **词汇已死**：仓库根几份仍以 `projectAuthority` / quarantine / `confirmDescendantSaveReload` 为现状，
   而这些机制**已在本轮删除**（见 §2 已作废）。

## 8. 文档取用（完整表见 `DOC-INVENTORY.md`）

- **必读**：本文件 · `DOC-INVENTORY.md` · `PRODUCT_NORTH_STAR.md` · `V2_ARCHITECTURE_BASELINE.md` · `HANDOFF-2026-10-02-E.md`
- **按需**：`TECHNICAL_MAP.md`（仓库事实，会漂）· `UTILITY-SITING-CONSTRAINTS.md`（**先读其顶部警示**）· `REMOVABLE-DURABLE-GATES-2026-10-02.md` · `INVESTIGATION-2026-10-01-road-course-and-facts-churn.md` · `V2_UTILITY_CONNECTION_STATE_CONTRACT.md` · `ROAD_EXECUTION_CONTRACT_PACKET.md` · `CAPABILITY-GAP-2026-10-02.md` · `EXPANSION-PACKAGE-MINIMAL-SLICE.md`
- **禁读（顶部已标"已过期"）**：`CURRENT_STATUS.md` · `IMPLEMENTATION_STATUS.md` · `NEXT_SESSION.md` · `ARCHITECTURE.md` · `LOCAL_MAYOR_ENGINE.md` · `LOCAL_MAYOR_GROWTH_STALL_AUDIT.md` · `LOCAL_MAYOR_CANONICAL_FRONTAGE_LIVE.md` · `ALPHA_HARDENING.md` · `CITY_ISSUE_AWARENESS.md` · `PRODUCT_SPEC.md` · `AI市长V2_*.md`（4 份）· `HANDOFF-2026-10-02.md` · `HANDOFF-2026-10-02-B.md` · `UDL_PHASE6_REALIZATION_AUDIT.md` · `UDL_ROAD_CANDIDATE_REJECTION_AUDIT.md`

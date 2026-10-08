# 能力缺口清单 —— 对照终极形态（2026-10-02）

**终极形态（产品目标，用户原话）**：本地自治为默认形态；云端 AI 只把自然语言译成结构化意图；本地精确执行，
成品风格要能让人眼前一亮（**横平成街区、层级分明、有变化**），不是整齐的碎块。

**规则**：凡标「缺失」的，都经过全 `src` 检索确认**没有实现**；只声明未实现的一律标「部分（声明未实现）」。
证据一律 file:line。**末尾给"阻塞什么"的分组。**

---

## 逐项

| # | 能力 | 结论 | 证据 | 说明 |
|---|---|---|---|---|
| A | **放置住宅/商业建筑** | **部分（且被实测否决）** | `growth-mode.ts:40-50`；`docs/ai-mayor/DIRECT_GROWABLE_PLACEMENT_CAPABILITY.md:3-4,26-56`；`v2/main-adapter.ts:133`（`place_building` 硬限 `actionFamily==="UTILITY"`）；`schema.ts:357-359`（`zone` 只接受已验证候选，不给坐标） | 产品**只画 zoning**，建筑由模拟自己长。直放 growable 实测后**立即 `condemned`、`roadEdge:null`、零 renters、两游戏小时内被清除** ⇒ 被明确判为 `NOT_SUPPORTED as a production fast lane`。zoning 是产生 lot 的唯一机制 |
| B | **密度与资产选择** | **缺失** | 密度仅语义：`urban-design/proposal.ts:42`、`grammar.ts:38-42`、`realization.ts:344-345`（只给**道路候选打分**）；zone 类型取法：`action-candidates.ts:254-309`、`:360-367`、`main-adapters.ts:2816-2823`（**按 areaType 取第一个未锁定的**，无密度维度）；桥：`tmp/bridge-*/RequestHandlers.Zoning.cs:169-233`（`/build/zone` **无任何密度参数**） | **没有任何"按密度选 zone 类型或选建筑 prefab"的实现**。建筑 prefab 完全由 CS2 spawn 系统在模拟里决定，产品不参与。`spawnableBuildingCount` 仅桥侧诊断返回，`src/**` 无引用 |
| C | **弯道** | **部分（管道有、生成无）** | 字段：`road-kernel.ts:57-58`（`cx?/cz?`）、`:107-130`（`roadCourseGeometry` 只**透传**，未给则退化直线）；透传链：`main-adapters.ts:2980`、`runtime-road-caller.ts:92,251`、`durability.ts:873,3587`；LLM 可发：`schema.ts:30-41`、`skill.ts:39`。**反证**：`road-course-sweep.ts:290-305,433-447` 只按 heading×length 生成**直线**且输出**从不含 cx/cz**；`curvature` 只在 `proposal.ts:41`/`realization.ts:43,196` **声明**，无几何消费者 | 若 LLM 显式给控制点，能被一路携带并授权；但**系统自身不生成弯道**，V2 求解器/扫描族产不出曲线 |
| D | **环岛** | **缺失** | 全 `src` 检索 `roundabout\|Roundabout\|Rotary\|环岛` **零匹配**；仅文档列为"后期"：`docs/ai-mayor/URBAN_DESIGN_LANGUAGE.md:183,548` | 无任何实现，连声明都没有 |
| E | **路口层级 / 道路 prefab 等级** | **部分** | 词汇：`action-candidates.ts:54`（`hierarchyPreference`）；**唯一用途是排序**：`:651-655`；UDL 侧：`proposal.ts:40`、`realization.ts:44,160,169,346`（打分偏置）。prefab **沿用相邻既有路**：`action-candidates.ts:604,624`，**无 Small/Medium/Large 等级阶梯** | 有层级词汇与排序/打分偏置，**没有"按层级选 prefab 等级"的实现** |
| F | **服务设施（学校/医院/消防/警局/公园）** | **缺失（放置/选址）；部分（观测）** | 无放置：civic prefab 名在 `src` **零匹配**；`local-mayor/service-recovery.ts:10` 声明 `place_service_building` **全 src 仅此一处**，`deriveServiceRecoveryIntent` 对非公用一律 `unsupported`（`:28,40-53,55-67`）；`local-mayor/state.ts:87-92` 明说医疗/教育/垃圾/消防"**never become a placement Goal**"。有观测：`local-mayor/issues.ts:207-231`（读 `efficiencyPercent`/`buildingCount`，全部 **`actionable: false`**） | 只被读成 deficit 问题且标记不可执行；**无选址谓词、无放置路径、无覆盖率读数**（只有 `run-ledger.ts:319-324` 的通用计数） |
| G | **拆除** | **缺失（产品路径）** | `skill.ts:27` 系统提示明确 "**Never demolish**"；`src` 全库 `demolish\|bulldoze` 只命中该禁令 + `utility-target-binding.ts:332` 一句注释。工具**存在**：桥 `tmp/bridge-*/RequestHandlers.Build.cs:182,582`（`/build/demolish`）、脚本把它列入 `FORBIDDEN_TOOLS`（`scripts/ai-mayor-water-phase7-live.ts:66` 等） | 底层有拆除能力，**产品运行时没有任何拆除实现**，反而在提示层显式禁止 |
| H | **意图词表** | **部分** | 实际动作：`build_road` / `zone` / `place_building`（`types.ts:24,77,95`；`schema.ts:119`）。**声明未实现**：`upgrade_road`（`types.ts:86`、`schema.ts:79`，**src 无任何执行 handler**）；family `"BUILDING"`（`foundation.ts:312` 声明，**无人写入**，`place_building` 实际记在 `UTILITY`）；结构化意图 `IMPROVE_TRAFFIC`（`types.ts:366` 接受，但 `autonomous-brain.ts:639-640` 不在 allowlist，`growthGoalFromStructuredIntent` 返回 null） | 域动作实际只有三个；另有一条独立词表（鼠标/键层面）在 `v2/control-layer/executor.ts:28-30` |
| I | **本地自治触发** | **已有** | `main.ts:237-238,270-277`（`AI_MAYOR_PRODUCT_MODE` 自动 start，无需玩家点）、`:606-608`（IPC 也固定 `decisionMode:"local", continuous:true`）；`runtime.ts:2249-2254`（local 走 `runAutonomousConstructionCycle`，云端 `ports.decide` 不在该分支）、`:2086-2093`（continuous 循环）；`v2/local-gate1-runner.ts:134-140`（注释：**云端救援到不了这条 routine runner**）；目标驱动：`autonomous-brain.ts:532-584,625-632` | 默认 local + continuous，云端不在产品路径上；唯一需玩家的是世界纪元变更/活性违规 |
| J | **设施放置入账** | **部分（产品路径已入账）** | **入账**：`v2/main-adapter.ts:4866-4891` 构造 `V2CommandRecord{actionFamily:"UTILITY"}` → `:4914 commandJournal.create()` → `:4932` 提交；即 `executeScopedUtility`（`:4371`），由 `greenfieldUtilityBootstrap` 注入（`:5229`，执行器 `:6610`）。产品 local 确实走它（`main-adapters.ts:885,2294` → `runtime.ts:2249-2254`）。**不入账**：legacy/云端 `executeLegacyActionBatch`（`main-adapters.ts:1175-1180` 直打 `cs2_mayor_execute_actions`），**只在 `decisionMode !== "local"` 分支**；脚本直连（`scripts/tmp-east-utility-place.ts:205` 等） | 产品 local 运行时**只有一条**设施放置路径且入账；不入账的那条不在产品自治路径上 |

---

## 分组：这些缺口各自阻塞什么

### 【阻塞"风格惊艳"】（横平成街区 / 层级分明 / 有变化）

| 缺口 | 为什么阻塞 |
|---|---|
| **B 密度与资产选择（缺失）** | 没有密度，就没有"层级分明"——同一块地只能长同一种东西，且由游戏随机决定长成什么。**这是"碎块感"的头号来源** |
| **C 弯道（有管道无生成）** | 没有曲线 ⇒ 没有"有变化"的街道形态，只能直角拼贴 |
| **E 道路等级阶梯（部分）** | prefab 沿用邻路 ⇒ 主干道与支路无法拉开等级，"层级分明"做不到 |
| **D 环岛（缺失）** | 缺少一眼可辨的城市地标构件 |
| **F 服务设施（缺失）** | 没有学校/医院/消防/公园 ⇒ **不像城市**，无论路网多齐整 |

### 【阻塞"自治"】（能自己一直干下去）

| 缺口 | 为什么阻塞 |
|---|---|
| **G 拆除（缺失）** | 铺错一条路、放错一个设施，**无法修正** ⇒ 长期自治必然累积废料，且提示层明令禁止 |
| **H `upgrade_road`（声明未实现）** | 路网无法升级 ⇒ 人口上去后主干道永远是支路 |
| **J 入账（部分）** | 产品 local 路径**已入账**，不阻塞；风险只在有人切到云端分支或直接跑脚本时 |

### 【不阻塞】已有

- **I 本地自治触发**：已有且是默认。
- **A zoning 出建筑**：这条**不是缺口**——直放已被实测否决，zoning 是**正确**机制；真正缺的是 B（密度）而不是"自己放房子"。

---

## 一句话总结

**"风格惊艳"缺 5 项（B/C/D/E/F），"自治"缺 2 项（G/H）。**
其中**密度与资产选择（B）**是唯一同时影响"街区感"与"层级感"的一项，也是当前"碎块感"最可能的根因：
产品画完 zoning 后对**长什么、长多密完全没有话语权**。

---

## 更新（2026-10-02 晚 · 道路几何收口）

本轮把"街区"从碎块推进到**可控几何**，但**尚未接入产品路径**（全部是纯函数 + 脚本）。

| # | 能力 | 上轮 | 本轮 | 证据 |
|---|---|---|---|---|
| K | **矩形/集合网格规划** | 缺失 | **纯函数已有** | `planRectangularGrid` · `planGridCollections` · `mixedGridDimensions` · `goldenRatioLadder`（`v2/road-grid-generator.ts`） |
| L | **地形过滤（水/陡坡）** | 缺失 | **纯函数已有** | `filterGridSegmentsByTerrain` · `reportGridCollectionsOnTerrain`；实测 31/144 可放 |
| M | **集合选址（连通性+地形）** | 缺失 | **纯函数已有** | `v2/grid-collection-site.ts`；细读 8 m，49 候选 6 可放 |
| N | **设施放置净空** | 缺失 | **已接线（可选口）** | `v2/facility-placement-clearance.ts` + `utility-recovery.ts` 的 `readPlacementContext?`（**暂无调用方**） |
| O | **三网分街** | 缺失 | **已有，且实测证明多数不需要** | `allocateUtilityStreets`；21 街只分出去 8 条 |
| P | **服务可达判定** | 缺失 | **纯函数已有** | `netsMissingService`（按连通分量，不按距离）；实测新区 `missing: none` |
| **Q** | **轴对齐网格 vs 共线折回** | —— | **新发现的硬冲突** | 连续同线 course 被 `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` 拒；`Medium Road` 连垂直首段也被 `409 REJECTED`（reason 不下沉） |
| **R** | **扩张链（选集合→铺路→服务→zoning）** | 缺失 | **脚本已有，实跑未达标（2/30）** | `scripts/tmp-expansion-chain-live.ts` |

**一句话（本轮）**：几何层已从"碎块"变成"可规划的街区"（集合、环路、等比格、地形否决、服务可达判定），
但**产品路径尚未接线**，且 **Q 是一道未解的设计级冲突** —— 它决定 (a)/(b)/(c) 三条路线怎么选。
详见 `HANDOFF-2026-10-02-B.md`。

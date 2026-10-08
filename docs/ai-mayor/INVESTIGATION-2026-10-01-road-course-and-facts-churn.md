# 调查记录 2026-10-01：道路认证的稀疏性、Goal 身份抖动，与"自己绊自己"的 17 块特判

> 这份文件记录的是**实测出来的事实**，不是推断。每条都附坐标或实验命令。
> 数据来源：运行中的 CS2（Bridge `0.8.3`，`127.0.0.1:8642`）+ canonical durable store
> `%APPDATA%\5ire\execution-branches\62e4e251f5497872673213c0c4fc9bb16ed0808a\ai-mayor-v2.json`

---

## 一、增长停滞的直接原因：native 拒绝道路候选（不是调度器）

实测两次 live（同 branchId `62e4e251`，同 worldId `cs2-session:d8413e4f`，各 5 ticks）：

| 指标 | BEFORE | AFTER |
|---|---|---|
| 每 cycle 道路段数 | 0 | 0 |
| zoning cells | 4 actions / 6214 | 2 actions / 1960 |
| construction 占墙钟 | 0.26% | 0.33% |
| cs2_spatial 占调用时间 | 73%（262s / 5378 calls） | — |

主导阻塞（每次 tick 的 `lastStatus`）：`NO_FEASIBLE_GATE1_ROAD_CANDIDATE`。

被拒理由直方图（BEFORE / AFTER）：

| native 裁决 | BEFORE | AFTER |
|---|---|---|
| `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` | 26 | 39 |
| `operation blocked by game validation (overlap, water, steep terrain, protected entity...)` | 20 | 27 |
| `NO_PRODUCTIVE_ROAD_EFFECT` | 4 | 6 |

涉及实体每次都是同一小批：`75948:215`、`77160:241`、`75476:37`、`76615:57`、`77062:303`。

---

## 二、候选来自旧 bounded heading family，**不是** P4

调用链（全部实测确认）：

```
gate1-progression-boundary.ts:195 reproduceCandidate()
  → :299 / :340 searchBoundedStarterSites()          ← site-selection.ts:1261
    → site-selection.ts:1064 resolveBoundedRoadCandidates()
      → road-connection-resolver.ts:723               ← 旧 bounded generator（899 行）
  → :661 candidates → :673 selectFeasibleRoadCandidate()
  → :740 失败 → "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:" + rejections
```

P4 `planRoadCorridor`（`spatial/road-corridor.ts:291`，网格 A\*）的调用方**只有**
`project-admission.ts:725`（准入）与 `water-site-constraint.ts:732`（utility），**不在这条路上**。

候选族被 `utility-planner.ts:452` 的"**25 度锥**去重规则"约束——这就是歪歪扭扭的路的来源。

---

## 三、决定性实验：native 认证的 course 是**稀疏且逐节点、逐长度变化**的

只读探针：`GET /spatial/preflight?mode=preflight&kind=net&prefab=<>&x1,z1,x2,z2[&startEndpoint=<JSON>]`
（与产品 `previewRoad` 同一条路径：`main-adapter.ts:6681` `callTool("cs2_spatial",{mode:"preflight",kind:"net",...})`）

**关键约束**：绑定已有节点时必须用 **scan 实时读到的坐标**，否则报
`ROAD_ENDPOINT_POSITION_MISMATCH`（`BridgeToolSystem.CreateRoadDefinitions`，stage=DEFINITION）。

结果（`Medium Road`，逐方位）：

**节点 `75948:215`（= 电目标节点，roadDegree=2，(1347.9,420.6)）**

| 长度 | 0° | 45° | 90° | 135° | 180° | 225° | 270° | 315° |
|---|---|---|---|---|---|---|---|---|
| 16m | 无提案边 | 校验拒绝 | 校验拒绝 | 无提案边 | 无提案边 | 校验拒绝 | 校验拒绝 | 无提案边 |
| 40m | 校验拒绝 | 无提案边 | 校验拒绝 | 无提案边 | 无提案边 | **✅ OK** | 校验拒绝 | 无提案边 |

**节点 `52196:1`（商业群节点，(825.3,622.9)）**

| 长度 | 0° | 45° | 90° | 135° | 180° | 225° | 270° | 315° |
|---|---|---|---|---|---|---|---|---|
| 16m | 校验拒绝 | 校验拒绝 | **✅** | **✅** | 无提案边 | 无提案边 | **✅** | **✅** |
| 40m | 校验拒绝 | 校验拒绝 | **✅** | **✅** | 无提案边 | **✅** | **✅** | **✅** |

**结论**：
1. native **不拒绝直线**——`cs2_build_road` 工具自述 "Straight by default"。
2. 可认证集**稀疏**（`75948:215` 上 16 次尝试只中 1 次），且**逐节点、逐长度变化**。
3. 两类裁决必须分开处理：
   - `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` = 该方位**连提案边都形成不了** → 换方位
   - `operation blocked by game validation` = 边形成了但**放置校验拒绝** → 换长度/微调位置
4. **把候选族从"25° 锥扇出"换成"方位 × 长度横扫"，就能从 1/16 提升到多次中靶。**
   这是"直线网格路"的最小实现，且 native dry-run 免费。

**待验证**：带 `startEndpoint` 的自由端点探针在 `(663,574)` 8m 直线上曾返回 VALID，说明部分地点原生就通。

---

## 四、Goal 身份随易变 facts 抖动（24 个 electricity work order 的来源）

`runtime.ts:1484-1486`：

```ts
const landUse = landUseOfExpansionGoalId(goal.goalId);   // 服务目标 → 兜底 "RESIDENTIAL"
const goalFacts = growthGoalFactFingerprint(goal.goalId, landUse, growthState);
const goalId = `${goal.goalId}:facts:${goalFacts}`;      // 指纹含 population/demand/capacity/financeBand/treasury
```

后果（store 实测）：
- `PROVIDE_SERVICE:electricity` = **24 个独立 work order**（15 个不同 facts hash + 9 个 successor hop）
- 13 个 `EXPAND_COMMERCIAL:commercial:facts:<hash>` 各建**一栋楼**，中心相隔 20–60 m，
  **这就是"沿路铺满却无水无电无污"的孤楼群的来历**——它们是 churn 的残留，不是一次规划的结果

**因此**：`OperationId` 派生**绝不能含世界事实**。世界变了应产出 `STALE`，不是新 id。

---

## 五、"自己绊自己"的 17 块特判（保留决策槽，换掉槽里的机器）

死循环源于：决策必须本地做（云 AI 只翻译、不能思考），而它被做成了**固定阶段机**，
于是每遇到一个阶段机没预料的情况就补一块特判：

FACTS park、TARGET park、GROWTH_TARGET_PARK_STRIKE_LIMIT、WORK_ORDER_STALL_CYCLES、
capabilityGappedFamily、goalOrderUnservableRoadTarget、isDomainScopedRefusal、
MAXIMUM_GOAL_PREREQUISITE_STEPS、GOAL_PREREQUISITE_ALREADY_SPENT、MAXIMUM_GOAL_SUCCESSOR_STEPS、
GOAL_WORK_ORDER_RELEASED_SCOPE_SUCCESSOR_REQUIRED、GOAL_WORK_ORDER_TERMINAL_SUCCESSOR_REQUIRED、
MAXIMUM_UTILITY_GOAL_SITE_SCOPES、BRAIN_GOALS_PARKED、
MAXIMUM_ZONING_UTILITY_COMMISSIONING_ATTEMPTS、brainLedger.exhausted、MAX_BRAIN_REPEATED_FAILURES。

**其中一处是真 bug**：`project-admission.ts:1226` 抛 `GOAL_SUCCESSOR_BUDGET_EXHAUSTED`，
而 `runtime.ts:271` 白名单写的是 `GOAL_SUCCESSOR_STEPS_EXHAUSTED`——**字符串从未匹配**，
导致预算耗尽的拒绝被当成"世界性拒绝"，整轮去等模拟而不是切 domain。（已修）

---

## 六、durable 存储的自砖陷阱（已修）

`durability.ts` 的 `completionStage` 校验原是**手抄白名单**
`["ROAD_DELIVERED","WAITING_FOR_OCCUPANCY","OCCUPIED"]`。写入新阶段
`ZONED_WAITING_FOR_BUILDING` 后，**加载器拒绝自己的存储**，整个 store 无法加载。

这与紧邻注释记录的 OFFICE 事故是**同一个 bug 类**（`durability.ts:1224-1230`）。
已改为单一来源常量 `GOAL_COMPLETION_STAGES`（`durability.ts`），校验器与规划器共用。

---

## 七、本轮已落地的改动（生产代码 +125 / −26）

| 文件 | 改动 |
|---|---|
| `durability.ts` | 新增 `goalWorkOrderJournalProvesUnservableRoadTarget`；`GOAL_COMPLETION_STAGES` 单一来源 |
| `project-admission.ts` | successor 收口点拒绝为"已证明路不可交付"的闭合 mint 新身份；增长 Goal 完成判据 → `ZONED_WAITING_FOR_BUILDING` |
| `gate1.ts` | `OCCUPANCY_DIAGNOSIS` 两个 BLOCKED 分支降级为**遥测**（照常记录、不再阻塞） |
| `runtime.ts` | 修字符串错配；新拒绝归为 domain-scoped |
| `scripts/ai-mayor-continuous-growth-live.ts` | 修 tempo 口径（`cs2_mayor_execute_actions` 按 action 类型分类，原先整体记为 facility）；新增四项产品指标与 `productOutcome` |

回归：**109 suites / 1780 tests 全绿**。

---

## 八、未做 / 待验证

- **未做**：utility 随 package 道路走廊铺设 + 完成判据改管网拓扑/容量（#10）；服务目标身份抖动（#6）
- **未验证**：P4 能否覆盖 bounded 候选族；基线"从同一存档重载"的机制（live 脚本主动拒绝 save/load）
- **未做写入实验**：道路连通能否代替 utility 命令（只有观测证据：有路无水电、有水无污、发电机未接线）
- **无法确认**：`15 树林巷 Chemicalore 是工业` —— 全城 34 栋非废墟建筑中无工业、无该 prefab

---

## 九、战略结论

1. **决策槽不能砍**（云 AI 只翻译），要换的是**槽里的机器**。
2. 工程书通道已存在（`MayorStructuredGoalIntent` → `runtime.ts:645 #pendingStructuredIntent` → `rankedGrowthGoals`），
   但**词表太粗**：只能表达"建哪类区"，不能表达 `BUILD_ROAD{from,to}` / `PLACE_BUILDING` / `DEMOLISH` / `CONNECT_COMPONENT`。
   **工程书读进来后被降级成"再划一片区"——死循环由此开始。**
3. 基建执行层**是好的**：native 原语齐全（`/build/road` 直线、`/build/place` 任意建筑、`/build/demolish` 建筑或路段），
   且执行/持久化内核与阶段机**已解耦**（`assertMutationAllowed` 零 Gate1 引用）。
4. **第一步**：`ROAD{from,to}` + **方位 × 长度横扫** + **持久化已认证 course 集**（绑定 world/topology 版本）。
   理由：占墙钟 73%、稀疏且只有 native 知道、且是"接孤岛"和"沿街建房"的前置。

## 九·补、正式横扫工具的首批结果（`scripts/ai-mayor-road-certification-sweep.cjs`）

8 方位 × 3 长度 = 24 次/节点：

| 节点 | 可认证 | 具体 |
|---|---|---|
| `75948:215`（电目标） | **1 / 24** | 225°@24m |
| `52196:1`（商业群） | **10 / 24** | 135°@16m, 270°@16m, 315°@16m, 90°@24m, 315°@24m, 90°/135°/225°/270°/315°@40m |

**稀疏程度比先前估计更极端**（1/24 vs 10/24），且**同一个方位换个长度结果就变**。

**新增运维约束**：`/spatial/preflight` 会返回 **409 `another build operation in progress`**
（single-flight 争用）。横扫工具必须对该错误**重试**，否则会把争用误记成"不可认证"。
这一条对任何执行 `probe` 的模块都成立。

## 十、诊断脚本（只读，位于 `tmp/`）

| 脚本 | 用途 |
|---|---|
| `tmp/inspect-service-goals.cjs <store.json> [prefix]` | 某族 work order 的 journal 与 task 状态直方图 |
| `tmp/cluster-provenance.cjs` | 哪些 goal 的 tranche 目标落在指定区域框内 |
| `tmp/analyze-cluster.cjs` | 建筑普查 × 全城警告交叉，定位无服务群落 |
| `tmp/audit-buildings.cjs` | 逐栋：prefab / 警告 / 人数 / 所属 work order |
| `tmp/probe-straight-road.cjs` | 自由端点直线路的 native 预检 |
| `tmp/probe-node-attached.cjs` | **绑定已有节点**的 native 预检（须用 scan 实时坐标） |
| `tmp/probe-headings.cjs` | **逐方位 native 预检**——可认证集的实测方法 |

## 十一、ROAD{from,to} 可执行模块落地（`road-course-sweep.ts` + `road-intent.ts`）

起点工具升级为产品模块。live 入口：`npx tsx scripts/ai-mayor-road-intent-live.ts`（只读）。

### 11.1 拒绝的真实传输形状（决定分类器怎么写）

被拒的 preflight 是 **HTTP 409 + 结构化 body**，body 里**没有** `valid` / `previewOnly` / `courseIntegrity`：

```json
{
  "validation": { "status": "REJECTED", "allowApply": false, "detailAvailable": false },
  "structural": { "generatedEdge": true, "generatedEdgeCount": 5, "generatedNodeCount": 6 },
  "nativeToolErrors": [{ "errorType": "SteepSlope", "errorPrefab": { "name": "Steep Slope" } }],
  "rejectionDiagnostics": { "stage": "APPLY_GUARD", "errorType": "UNKNOWN",
    "message": "operation blocked by game validation (...)", "allowApply": false, "nativeCommandCreated": false }
}
```

真实信号是 `rejectionDiagnostics.stage` + `errorType` + `nativeToolErrors[].errorType`。
只读 `valid`/`courseIntegrity` 的分类器会把每一次拒绝都读成 `UNKNOWN`。

**`stage: "DEFINITION"` 不是关于这条路的事实**：`CreateRoadDefinitions` 阶段拒绝
（`ROAD_ENDPOINT_POSITION_MISMATCH`）说明**绑定本身错了**，同一 source 的每一门课都会同样失败。
把它当作"换长度再试"会白扫 24 次并伪造出一个 EXHAUSTED。模块对它单列
`ENDPOINT_BINDING_FAILED` / `ROAD_INTENT_ENDPOINT_BINDING_REJECTED` 并立即中止。

**另一个坑：`native` 是 origin metadata，不是授权。** 节点 `75948:215` 在 scan 里
`native: false`，却是完全合法的道路源——本产品自己建的路回来都不带 native 标记。
用它当门会排除掉**正在扩张的那张网本身**（`gate1-progression-boundary.ts:441-450` 已踩过同一处）。

### 11.2 模块独立复现了第三、九·补节的稀疏表

`resolveRoadIntent` 从 scan 实时坐标绑定 START，然后在 8 方位 × 3 长度上横扫：

| 节点 | 结果 | 调查记录里的对应项 |
|---|---|---|
| `75948:215` | ordinal 16 → **225°@24m** | 第 3 节 1/24：225°@24m ✅ |
| `52196:1` | ordinal 6 → **90°@16m** | 第九·补节 10/24 含 90°@16m ✅ |

两处都是**独立复现**，不是抄表。operationId = `hash(intentId, ordinal)`，两次运行同值。

### 11.3 拒绝也必须缓存（吞吐的固定成本）

只缓存"认证通过"时，同一 source 每 tick 仍要重付命中前的全部拒绝：
`75948:215` 上命中在第 17 次探测，即 16 次白付。

拒绝并入同一个 (world, topologyRevision) 作用域后，第二次运行 **probes 17 → 0**。
安全性来自作用域本身：课程被拒是土地与路网的事实，而 Mayor 一旦建成任何东西，
graph revision 就变了，旧条目再也命中不到。`ENDPOINT_UNBOUND` / `UNKNOWN` 永不入缓存
（前者是本模块自己够不着网的故障，后者根本不是答案）。

### 11.4 测试与回归

- 新增 `test/ai-mayor/v2-road-course-sweep.spec.ts`、`test/ai-mayor/v2-road-intent.spec.ts`（37 tests）
- 回归 **111 suites / 1817 tests 全绿**（基线 109/1780 + 本轮 2/37）
- 拒绝 body 用的是上面那段**实测原文**做 fixture，不是转述

## 十二、接进 live 增长路径：真正的阻塞点是"被认证的路被判成无产出"

`swept` 族接进了 `reproduceCandidate()`，排在 `bounded.candidates` **之后**（`directed` → `bounded` → `swept` → `generic`）。
放在之后而不是之前，是因为 `bounded` 的课程才是"被持久化 target 的确定性重现"，回放确定性靠它；
新族在一个旧族本来就通的世界里抢走选择，会**无实测收益地换掉提交的几何**（本轮实测：抢走后原本贯穿保留区的 36 m 路变成 8 m 残段）。

### 12.1 两道与本模块无关、但挡住路的闸

**A. `MAXIMUM_ROAD_FEASIBILITY_CANDIDATE_BUDGET` 静默截断（`road-candidate-feasibility.ts`）**
Gate1 现在组合出 `directed(≤3) + bounded(≤24) + swept(≤25) + generic(≤24)`，而上限是 24，
于是 **swept 全部 25 条课程生成完毕、全部通过 owned-land 过滤、却一条都没被探测**——
单测确认（`falls through to the measured heading × length sweep`）。已改为 96：这是"防止无界列表"的护栏，
不是给某一个族的预算，调用方自己组合出来的族不该被它悄悄砍掉。

**B. `nativePreviewHasNewRoadEffect` 要求"同时"有新边和新点（`runtime-road-caller.ts`）** ← **真正的阻塞点**
它读 `generatedTempEntities` 窗口，原来写 `hasNewEdge && hasNewEndpoint` 才算"产生了新拓扑"，
窗口完整且不含新实体时判 `NO_PRODUCTIVE_ROAD_EFFECT`。

**接在既有/被切分节点之间的新路段只产生新边，不产生新点。** 实测 `75948:215` 上那条唯一可认证的课程：

```
HTTP 200  valid=true  previewOnly=true  validNewRoadProposal=true
courseIntegrity.proposalEdgeCount = 1     postHandoffGeometryPreserved = true
structural: generatedEdgeCount=5 generatedNodeCount=5
窗口（完整，10 条）：5 个 original 非空 NODE + 4 个 original 非空 EDGE + 1 个 original=null EDGE + 0 个新 NODE
```

native 明确认证、并报价 132。旧判据读成 `NO_PRODUCTIVE_ROAD_EFFECT`。
已改为 `hasNewEdge || hasNewEndpoint`：窗口里出现任何**真正新增**的实体就是新拓扑。
（窗口不完整时仍回落到"native 自己的 `NEW_ROAD_PROPOSAL_EDGE` 认证为准"，那一段不变。）

### 12.2 live 实测：路真的建出来了

| run | 改动 | `cs2_build_road` | tick 表现 |
|---|---|---|---|
| run1 | 无 | 0 | tick2 `NO_FEASIBLE_GATE1_ROAD_CANDIDATE` |
| run2 | 接线 + 绝对方位 + 上限 96，**无 12.1B** | 0 | tick2 仍 `NO_FEASIBLE`（48 条拒绝） |
| run3 | **含 12.1B** | **3** | tick1、tick2 均 `ZONED_WAITING_FOR_BUILDING` |

run3 地面真相（`/spatial/bootstrap-scan` 前后对比）：**edges 400 → 403，nodes 398 → 400**；人口 28 → 43。

**归因要诚实**：run3 建出的三条路是 `len=21.43 / 29.12 / 23.05` 的 `bounded` 族几何，**不是** swept 族。
真正解开阻塞的是 12.1B。swept 族是已接线、可达、有测试的**后备**，本轮未产出路。

### 12.3 扫描必须锚在绝对罗盘方位，不是 site 方向

`75948:215` 与 `52196:1` 上**每一条**可认证 course 的 heading 都是 45° 的倍数（225°；90°/135°/225°/270°/315°）。
把 8 个 offset 锚在"朝 site 的 bearing"上会把整个族转离那张网格：实测同一节点，site 锚定的 24 条**全被拒**。
已改为 `bearingDegrees: 0`（绝对方位），site 方向仍作为该族的 direct course 提供。
所以 `planRoadCourseSweep` 是"bearing + offsets"，调用方用 `bearingDegrees: 0` 得到绝对族。

### 12.4 长跑卡住的真因：Brain 的模拟窗口从不关里程碑弹窗（已修）

run3 的 tick3/4、run4 的全部 tick 都停在 `CS2 simulation did not auto-pause before timeout`。
现场 `/state`：`paused=true, effectiveSpeed=0`，10 分钟只推进 15 帧。

**真因**：里程碑弹窗会**立刻把游戏暂停**。runner 的模拟窗口等的是"推进后自动暂停"，
帧不推进 → `observedProgress` 永假 → 每 tick 都走 stall 分支。

`blocking-modal-guard.ts` 早就写下了规则（`guardBeforeSimulationProgress`）：
"Future simulation drivers must call this bounded hook before advancing time."
但**只有旧的 plan / local-mayor 两条路径调了它**（`runtime.ts` 的 2346、3052 处），
而 V2 Brain 自己驱动模拟窗口的三处（`#awaitSimulationWindow` 与 `observe()` 里的
`runSimulation`）一处都没调。实测证据：run3/run4 整个运行里 `cs2_read_blocking_modal`
调用数为 **0**。

已抽出 `#dismissBlockingModal()` 并在两个 Brain 模拟窗口前调用（`runtime.ts`）。
守卫只关非胜利里程碑、关后复验、其余一律 fail-closed。

**修在咽喉处，不是逐调用点**：第一次只给 `runtime.ts` 的两处加了守卫，live 里
`cs2_read_blocking_modal` **仍然是 0**——因为增长循环根本不经那两条路。
真正的驱动是 main-adapters 的 `runBoundedSimulation`（2837 行），四条路径**全部**汇聚到
`runSimulation()`。守卫已移到那里（一处覆盖全部），runtime 里的两处撤掉以免同一窗口读两遍。

**live 复验通过**：run7 里 `cs2_read_blocking_modal` = **24**（此前每次 run 恒为 0），
4/4 tick 跑完，无一次 `did not auto-pause`。

### 12.5 重启后每个 tick 都卡在 descendant confirmation（已修）

用户重启游戏载入同一存档后，每个 tick 都 BLOCKED：
`descendant confirmation leaves command 308dc6ca-… unproven`。

根因**不是**世界回退。那条命令是 ZONING，15 格里 **14 格完全吻合**，只有一格
`(-22.93, -80.80)` 在 1 m 容差内**出现两个** current cell：

```
记录位置 (-22.9317, -80.7988)   block 74929:23 #3
  50610:1 #3   d=0.0000  residential  visible=true   roadside=true   ← 就是它
  50551:1 #27  d=0.9394  none         visible=false  roadside=false  ← 容差带里的杂音
```

`matches.length !== 1` → INCONCLUSIVE → UNPROVEN。**记录侧只收 `visible === true` 的格子**
（`matchRecordedZoningCells` 的 footprint 过滤器），当前侧却不过滤——
**拿过滤过的集合去比未过滤的集合**。加回 `cell.visible === true` 后 live 数据 15/15 通过。

`visible` 正是 `foundation.ts` 里 `nativeZoningMarqueeFootprint` 用的判据：不可见的格子
本来就不是可划区的格子，不可能是"第二个候选"。两个匹配器都改了。

## 十三、城市在动（2026-10-01 收尾实测）

| run | `cs2_build_road` | tick 结果 |
|---|---|---|
| run1（改动前） | 0 | tick2 `NO_FEASIBLE_GATE1_ROAD_CANDIDATE` |
| run3 | 3 | 2/4 tick 完成，2 个卡 auto-pause |
| run6 | 3 | **4/4 完成**（descendant 修复后） |
| run7 | 6 | **4/4 完成**，`cs2_read_blocking_modal`=24 |

**世界地面真相**（`/spatial/bootstrap-scan` 前后对比）：
**nodes 398 → 408，edges 400 → 414** —— 本次会话真的建出了 14 条新路段。

### 13.1 下一个主导阻塞：Office 能力缺口

run7 的 4 个 tick 里 2 个停在
`GATE1_OFFICE_ZONE_PREFAB_UNAVAILABLE: the native planning catalogue exposes no unlocked Office area type`。

地图册实测只有 Residential / Commercial / Industrial 三种 areaType，**没有 Office**——这是真实能力缺口。
`runtime.ts:1229-1244` 的 `capabilityGappedFamily` 已经为它设计了"本轮让位"，
但触发条件是 `closedActiveWorkOrder`（work order 链已关闭），且让位只持续**本 cycle**；
一个 cycle 就是一个 tick，所以每个新 tick 又会重新规划 Office 一次。
**这是下一件该做的**：让 Office 家族在能力缺口下不要每 tick 重新入场。

### 13.2 本会话改动的文件

生产：`road-course-sweep.ts`(新) / `road-intent.ts`(新) / `gate1-progression-boundary.ts` /
`road-connection-resolver.ts`(仅类型) / `road-candidate-feasibility.ts` / `runtime-road-caller.ts` /
`runtime.ts` / `main-adapters.ts`
脚本：`scripts/ai-mayor-road-intent-live.ts`(新)
测试：`v2-road-course-sweep` / `v2-road-intent` / `v2-gate1-progression-boundary` /
`v2-road-kernel` / `v2-zoning-cell-identity` / `main-adapters`
回归：**111 suites / 1823 tests 全绿**；`tsc` 全仓 646 个错误与基线**逐条相同**（新增 0）。

---

## 十四、产品愿景与"等待"的判断标准（2026-10-01 用户冻结）

> 这一节是**评价标准**，不是实现方案。后续所有 growth / admission / scheduler 改动按它判断，
> 具体实现不限。参考的外部意见已并入。

### 14.1 卖点不是自动 zoning

用户对**云端 AI** 描述想要的城市/区域/风格，**云端只负责编译成结构化意图**；
**本地 Mayor** 依真实地图、资产 catalogue、道路、地形、服务网络与预算做具体规划，
并以**机器速度真正施工出来**。

**云端不负责**具体坐标、prefab、road course——那些是本地决策。

**肉眼最终效果**：
```
连续批量修路 → 直接批量建设合法建筑 → utility/service 跟进
→ 某一区域等待 simulation 时，其他区域继续施工
```

**zoning 可以保留，但不能把产品重新限制成"划区后慢慢等游戏长房子"。**

本地执行能力最终要能表达：`ROAD` / `PLACE_BUILDING` / `UTILITY_CONNECT` / `DEMOLISH` / `ZONE`。
"任何风格许愿"由本地一层**很薄的资产解析**承接：
`StyleIntent → AssetResolver(catalogue / geometry / roadAccess / service) → ConcretePrefabCandidates → PLACE_BUILDING`。

### 14.2 当前 blocker 的验收标准：`UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING`

这一条**正好检验路线有没有修对**，因为它同时暴露"能力"和"等待"两件事。

**希望的结果**：
```
Utility A 缺前置建筑
  → A 只进入它自己的 WAITING
  → 不改身份、不伪造完成、不生成 successor
  → Mayor 继续执行其他 unrelated ready work
  → 世界变化后 A 的条件满足，再回来继续
```

**不希望的结果**（那就只是旧控制层换了名字）：
```
等 N 次 → suppress N tick → park → retry budget
```

### 14.3 代码层判断标准：WAITING 是 operation 的局部状态

```ts
type OperationState =
  | { kind: "READY" }
  | { kind: "WAITING"; wakeOn: WorldPredicate }
  | { kind: "APPLIED"; evidence: Evidence }
  | { kind: "BLOCKED"; reason: BlockReason };
```

- 全局只需**持续消费当前依赖与世界条件都满足的 ready work**；
- 可以有很多活跃任务，但 **native mutation 仍保持 single-flight**。

### 14.4 核心边界（一句话）

**执行层要强到能兑现任意具体建设计划，但不要强到自己决定计划；
等待只冻结自己，不能冻结整座城市。**

### 14.5 实测现场（run8，2026-10-01 23:03）

Office 缺口修掉后，主导阻塞换成：

```
tick 1: EXPAND_INDUSTRIAL (ZONED_WAITING_FOR_BUILDING)
     → PROVIDE_SERVICE:electricity  ROAD_DELIVERED / WAITING_FOR_OCCUPANCY
tick 2/3/4: 同一个 work order，UTILITY_PROVISION:PENDING 尝试 24 → 48 → 49 → 50
reason: UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING
同时时间线出现: every expansion domain the city wants refused its own land
runner 的 48 个模拟窗口预算被这个"等世界"烧光（run8 只建成 1 条路，run7 是 6）
```

即：**一个 `PROVIDE_SERVICE` tranche 把整个 cycle 按在等待上**，而不是让别的域继续施工。
这正是 14.3/14.4 要消除的形状。

**durable 现场（`62e4e251…/ai-mayor-v2.json`，2026-10-01 23:0x）**：

```
PROVIDE_SERVICE:electricity   43 个 work order  ← 23 SUSPENDED / 19 BLOCKED / 1 ACTIVE
EXPAND_COMMERCIAL             14  ← 13 BLOCKED
EXPAND_RESIDENTIAL            15  ← 13 COMPLETE
EXPAND_INDUSTRIAL              4  ← 4 COMPLETE
EXPAND_OFFICE                  4  ← 4 BLOCKED
```

**两个必须一起看的结论**：

1. **身份 churn 还在继续，不是历史残留。** 第四节的调查当时看到 `PROVIDE_SERVICE:electricity`
   有 24 个 work order；现在是 **43**。这正是 14.2 明确禁止的"生成 successor"。
2. **扩张并没有真的没地。** `EXPAND_RESIDENTIAL` 13 次 COMPLETE、`EXPAND_INDUSTRIAL` 4 次 COMPLETE ——
   所以"every expansion domain refused its own land"是**那一刻**的读数，不是城市的状态。
   真正卡住的是 electricity 这条链自己在原地打转。

**为什么这个 goal 永远等不到它的前置建筑**：`gate1.ts:1820` 的 eligible 过滤里有
`(!baseUtilityGoal || !RESIDENTIAL_GROWTH_TASK_KINDS.includes(candidate.kind))` ——
对 utility goal，`ZONING` 被**故意排除**。所以 `ROAD_DELIVERED` 阶段 `chooseGate1CapabilityTask`
只能挑到 `UTILITY_PROVISION`（`autonomous-brain.ts:352` 的 `["ZONING","UTILITY_PROVISION"]` 里 ZONING 已不在 byKind）。
**utility goal 无法产出自己在等的那个建筑，只能等别的 tranche 给它**——而它每秒都在重试并占着 Brain。

**下一步的靶心**（即 14.2 的验收）：让这条链进入**自己的 WAITING**（`wakeOn` = 本 scope 出现可归属建筑），
**不生成 successor、不占 Brain**，其他域继续建。

### 14.6 Office 能力缺口的收尾（已完成，作为同类问题的正确形状参考）

Office 是**真实能力缺口**（地图册实测只有 Residential / Commercial / Industrial，
无 `office: true` 条目），不是 land 问题。已按"能力=有证据作用域的世界事实"落地：

- 能力事实每 cycle 从 catalogue 读一次，**通过候选生成器自己那个函数**读（`zoneOptions`），
  所以"能生成候选"和"能划区"由构造一致；
- 规划层在**生成工作之前**过滤（`cannotZoneDomain`），不是"选→失败→suppress→下 tick 再选"；
- **没有引入新 park**：答案是 catalogue 的事实且每 cycle 重读，分类解锁时它自己回来；
- 顺带修掉 `readZoneCategory("office")` 找 `areaType === "Office"` 的命名不一致——
  地图册从不这么命名 Office（它是 office 标记的 `Industrial`），
  **即使解锁了也会照样报缺口**。

**live 验证**：`GATE1_OFFICE_ZONE_PREFAB_UNAVAILABLE` 0 次（此前每两 tick 一次）；
证据里的 `EXPAND_OFFICE` 全部是 durable 中 `status:"BLOCKED"` 的**历史** work order，无新规划。
测试：`v2-autonomous-brain.spec.ts` 两条（catalogue 无 Office → 不生成该域工作；catalogue 未读 → 不抑制任何域）。

### 14.7 三条已经查清、别重复查的事实（2026-10-01）

1. **"等待占住 Brain"这一半其实已经实现了。** `runtime.ts:1874-1897`：
   连续 `AUTONOMOUS_BUILD_BURST_ATTEMPTS` 次推进后 tranche 位置没动 → `burstFoundOnlyWaiting = true`
   → `pursueNextGoal({ closedGoalChain: true, stalled: true })` **去问策略要别的 Goal**。
   那段注释就是为这条 electricity Goal 写的。run8 里它**确实走到了**，
   是策略当时**真的没有别的域**（时间线：`every expansion domain refused its own land`）。
   所以要改的不是"缺这条分叉"，而是"策略为什么没有别的域"。

2. **`exhausted` 对 base utility goal 恒为 false**（`gate1.ts:2295`：`!baseUtilityGoal && …`）。
   所以 active 的 electricity tranche **不会**被等待终止、不会伪装完成——"不伪造完成"这条本来就成立。
   43 个 work order 不是从这条路径来的。

3. **已证伪：悬挂的 utility work order 并没有锁住土地。** 曾假设 23 个 `SUSPENDED` 的
   electricity Goal 各自占着保留地、把扩张的土地吃光。**实测否**：
   43 个 electricity work order 里**只有 1 个**仍持有保留地（`releasedReservationAt == null`，
   且就是那个 ACTIVE 的），另外 42 个都已释放。
   所以 churn 的代价是**durable 膨胀 + 反复派生**，不是 land lock。**不要再按这条查。**

**结论**：真正烧掉 48 个模拟窗口的是 `runtime.ts:1899-1925` 的等待循环——
当策略没有别的域时，每次 pass 跑 `AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS`(3) 个模拟窗口，一个 tick 里重复多次。
而"策略为什么没有别的域"要往**扩张域的选地**查（run1/run2 出现过 `NOT_OWNED:3` / `NOT_OWNED:31`）。
剩下的 14.2 工作，本质是**身份移植**（OperationId 由意图而非世界事实派生，
见 `ai-mayor-control-plane-verdict`），那是动 durable 状态的改动，需要边跑边看。

### 14.8 `NOT_OWNED` 的直方图是错的标签——占主导的是 scope，不是 ownership（2026-10-01）

`site-selection.ts:1058` 把两件不同的事塞进同一个计数器：

```ts
if (!pointWithinCircleScope(point, localScope) || !owned(point, input.world.ownedTiles)) {
  rejections.NOT_OWNED += 1; continue;
}
```

"不在该 anchor 的**观测圆**内" 被报成 `NOT_OWNED`，于是这张直方图**无法回答"是不是自有土地"**。

**实测拆解**（`continuous-growth-loop-live.json` tick 3，nearby replay）：

```
anchorsSeen 36,  evaluated 0
NOT_OWNED 31 + NOT_BUILDABLE 5 = 36   ← 每个 anchor 恰好计一次
```

nearby replay 对每个 anchor 只测**同一个点**（`targetPoints = [{...replayTarget.center}]`，site-selection.ts:1014）。
同一个点对 36 个 anchor 给出 31 次 `NOT_OWNED`，而 `owned(point)` 对固定点是常量——
**差别只能来自逐 anchor 变化的 `localScope`**。

**再验证那个点本身**：run4 的失败 target `(x=-6.1777, z=-4.2330, r=24)` 落在自有核心地块
`[-311.65 … 311.65]²`（live scan：**529 个 tile 里只有 9 个 `owned` 且带 bounds**，合计约 3.5 km²）**内部**。
所以它**是自有土地**，`NOT_OWNED` 报的是假的。

**因此**：
- `localScope = { center: detail.center, radius: detail.radius }` 是**anchor 的观测圆**，不是保留区；
  要求持久化的 reservation 落进某个 anchor 的观测圆，是**scope 约束**，不是 ownership 约束。
- 这个计数器**混了两因**，也**掩盖了"哪种情况占多数"**。要往下查，第一步是把它拆开
  （注意 `OUTSIDE_PROJECT_SCOPE` 已被 1177 行的"被项目 scope 过滤掉的 anchor"占用，
  不能直接复用，否则是换一种混淆）。
- **不要为了吞吐放宽 `owned()`**：本轮已证明失败的点是自有土地，放宽 ownership 不会解决任何东西，
  只会把真正的 scope 约束藏起来。

## 十五、交回清单（2026-10-01，按优先级）

### 15.1 先做：把 `NOT_OWNED` 拆开，再判断那条 scope 约束（14.8）

**这是当前限速的东西。** 已知：
- `site-selection.ts:1058` 把"不在 anchor 观测圆内"与"不在 owned tiles 内"混进一个计数器；
- 实测占主导的是 **scope**，不是 ownership（36 个 anchor 测同一个点，31 次拒绝；该点经核对**是**自有土地）；
- **不要放宽 `owned()`**。

下一步：
1. 拆分计数器，需要一个**新 reason**（`OUTSIDE_PROJECT_SCOPE` 已被 1177 行占用，不能复用），
   并同步 `emptyRejections`、`project-admission.ts` 的两处字面直方图。
2. 跑一轮 live，拿到干净的两类数字。
3. 再回答真问题：**"reservation 必须落进某个 anchor 的观测圆"这条约束对不对**——
   观测半径相对扩张步长太小的话，搜索会在离目标一步之遥的地方停住。

**验收**：修完后看其他 ready construction 是否恢复、**地图是否明显继续扩张**（不看某个 Goal PASS）。

#### 15.1 实测结果（2026-10-01，已落地 + 只读复现）

**1. 拆分已落地。** `site-selection.ts` 新增 reason `OUTSIDE_ANCHOR_OBSERVATION`；
`OUTSIDE_PROJECT_SCOPE` 保持 1177 行原义（**anchor 本身**被项目 scope 滤掉），未复用。
同步了 `emptyRejections()` 与 `project-admission.ts:853 / 1813` 两处字面直方图。
`111 suites / 1826 tests` 全绿（基线 1825 + 新增 1）；`tsc --noEmit` **646**，与基线逐条相同。
新增回归测试 `separates the anchor's observation circle from ownership in the rejection histogram`。

**2. live 拿不到数——因为 15.2 的等待先把 Brain 卡死了。**
`AI_MAYOR_LIVE_TICKS=4` 一整轮 12.7 分钟：**0 个可见 mutation**（`roadSegments 0 / zoningActions 0 /
facilityActions 0`），48/48 个模拟窗口烧光；tick1/2 停在
`UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING`，tick3/4 直接
`LIVE_NATIVE_ACTION_BUDGET_EXCEEDED:cs2_run_simulation:48`。
证据：`fastExpansionMetrics: null`、`UTILITY_PROVISION attempts: 74`、`ZONING attempts: 0`、
`workOrderCount 90 → 90`。**增长/选地路径一次都没被走到**，所以报告里根本没有 `rejections`。
这正是 14.5/14.7 的形状的复现，也说明**实践上 15.2 排在 15.1 第 2 步之前**（交回清单的顺序需要按此重排）。

**3. 干净的两位数字用只读探针拿到**（`tmp/probe-rejection-split.ts`，只调
`cs2_game_state` / `cs2_mayor_snapshot` / `cs2_spatial(scan|detail)`，不写、不 preflight、不推模拟）。
对 14.8 的失败 target `(-6.1777,-4.2330,r=24)` 复刻 nearby replay 的**确切形状**
（`replayTarget` + `goalWorkOrderAnchors` + 生产观测半径 `siteObservationRadiusMeters = 96`）：

| 计数 | 值 |
|---|---|
| anchorsSelected | 47 |
| anchorsInsideObservationCircle（≤96 m） | **7** |
| anchorsOutsideObservationCircle | **40** |
| nearestAnchorDistance | **19.17 m** |
| `OUTSIDE_ANCHOR_OBSERVATION` | **40** |
| `NOT_OWNED` | **0** |
| `NOT_BUILDABLE` | **7** |
| 其余一切 | 0 |
| candidates | 0 |

（旧计数器会把这张表印成 `NOT_OWNED: 40`。）

**4. 回答第 3 问：那条 scope 约束不是限速点，14.8 的"观测半径太小"猜测被证伪。**
- 离目标最近的自有道路节点只有 **19.17 m**，远在 96 m 圆内；圆内有 **7** 个 anchor。
  搜索**没有**"在离目标一步之遥处停住"——那一步早就跨过去了。
- **`NOT_OWNED` 恒为 0**：这块地是自有的。14.8 的结论（`owned()` 不是原因）现在由直方图本身证明，
  不再依赖"固定点的 owned 是常量"这一步推理。
- 那 40 个 scope 拒绝**全部来自结构性无法作答的 anchor**：`localScope` 是 anchor **自己**的观测圆
  （center = anchor 位置，radius = 96），而 anchor 集按 owned-tile 轮转铺满全图，
  47 个里只有 7 个覆盖该点。**直方图按 (anchor × point) 配对计数——远处的 anchor 给每个计数器灌水**，
  所以任何"top rejection reason"的读法量的都是 anchor 铺开的程度，不是任何约束的松紧。
  这条对**所有** reason 都成立，不只 `NOT_OWNED`。
- **真正挡住的是 `NOT_BUILDABLE`**：保留地圆心 **8.94 m** 处有已建物
  `IndustrialManufacturing01_L1_4x3`，落在 24 m 保留半径内，7 个圆内 anchor 全部命中
  `hasBuildingConflict`（`site-selection.ts:222`）。**这块保留地被压在一栋工业楼上。**

**下一步（已改靶）**：不是放宽 scope 约束、也不是放宽 `owned()`，而是查
**"reservation 怎么会落在一栋已建物上"**——保留地是建筑出现之前挑的、还是建筑后来建进了保留地。
先用 `tmp/probe-rejection-split.ts`（`PROBE_TARGET_CENTER` / `PROBE_TARGET_RADIUS` 可覆盖目标点）
在别的失败 target 上重复，确认这是普遍形状还是个例。

#### 15.2 实测结果 A + C（2026-10-01，已落地）

**A. 等待不再消费 Brain / 模拟预算（已落地）。**

根因是两个**独立**的谎，都在同一口井里：

1. `local-gate1-runner.ts` 的 `wakeForTask` 对 `UTILITY_PROVISION` 一律返回 `SIMULATION_PROGRESS`。
   而 base utility goal 的 `ZONING` 被 `gate1.ts:1820` **故意排除**，所以它等的建筑只能由**别的 tranche**
   产出——时钟**证明不能**供给这个事实。新增 wake 词 `DEPENDENT_CONSTRUCTION` 说出这一点，
   并严格 gate 在 `baseUtilityGoal` 上（增长 Goal 的 `UTILITY_PROVISION` 等的是自己消费者初始化，
   确实是世界供给的，必须保留 `SIMULATION_PROGRESS`）。
2. `runtime.ts:1899-1925` 的外层等待循环**从不读 result 的 wake**，于是每 cycle 再花 4 个
   `AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS` 窗口。现在循环首行按 wake 判断"跑世界能不能产出这个事实"，
   不能就结束 cycle，并把 reason 前缀从 `..._WAIT_BUDGET_EXHAUSTED:` 改成 `..._LOCAL_WAIT:`（不再说谎）。

**绕开的陷阱**：`gate1-progression.ts` 里非 `SIMULATION_PROGRESS` 的 LOCAL_WAITING 会落到
重试尾（:603-617），重试 3 次**观测**后返回 **BLOCKED**——会把*等待*的 tranche 变成*阻塞*的。
新分支在 `break` **之前**返回 WAITING，**零模拟窗口、零 durable 写入**（不 park / 不 strike /
不 suppress / 不派生 successor）。这正是 14.2 禁止的 `等 N 次 → suppress → park` 形状的反面。
`runtime.ts:1584` 的 `ALL_DOMAINS_REFUSED → observe()` **保留**：它问的是"每个域都拿不到自己的地"，
世界确实能改变它；此前看起来像烧窗口，是因为外层循环把同一结论又收了一次费。

测试：`111 suites / 1829 tests` 全绿（基线 1826 + 3）；`tsc --noEmit` **646** 与基线逐条相同。
新增：`wakeForTask` 决策表（两侧都钉）、progression 层"买了 0 个窗口且不是 BLOCKED"、
runtime 层"该 wait 下窗口数 ≤1（那 1 次是策略自己的 `observe()`）且 reason 是 LOCAL_WAIT"。

**A 的 live 复验（2026-10-02 00:27，4 tick）**：

| 指标 | 修前 | 修后 |
|---|---|---|
| `cs2_run_simulation` | 48（烧满预算） | **8** |
| tick 墙钟总计 | 762,834 ms | **106,323 ms** |
| tick1/2 lastStatus | `..._WAIT_BUDGET_EXHAUSTED:GATE1_WAITING_FOR_WORLD_AFTER_3_SIMULATION_WINDOWS:...` | `AUTONOMOUS_CONSTRUCTION_LOCAL_WAIT:GATE1_WAITING_ON_DEPENDENT_WORK:UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING` |
| tick3/4 | `LIVE_NATIVE_ACTION_BUDGET_EXCEEDED:cs2_run_simulation:48` | 正常跑完，4/4 |
| `GATE1_WAITING_ON_DEPENDENT_WORK` 出现 | 0（不存在） | **12** |
| `visibleMutationCount` | 0 | **0**（**预期**：前庭/占地问题未动） |

策略回答仍是 `TARGET_PARKED` ×10 / `ALL_DOMAINS_REFUSED` ×10 —— 增长域的拒绝**没有变化**，
这正是 C 说明的那件事：A 修好了"等待不冻结城市"，但城市仍拿不到地。

**C. 前庭拒绝的分类（只读探针已落地并跑过）。**

新增 `tmp/probe-frontage-refusal-class.ts`（只读：`game_state` / `mayor_snapshot` / `spatial(scan|detail|preflight)`）。
为它把**模块级**的 `corridorFirstHopTarget` 加了 `export`——**零行为变化**，换来探针逐字复刻生产
（含 `maximumLength:2048` / `CORRIDOR_HOP_METERS:150` / 绕行比 2.5 / 20k 格 / 坡度 25 这些私有常量），
不像重写那样会漂移。

本轮世界（`worldId cs2-session:d8413e4f…`）：ring 只有 **4 个 anchor / 9 个自有本地路节点**。

| 分类 | 结果 |
|---|---|
| `GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION` | **2 / 4** |
| `MISSING_FRONTAGE` → `corridorFirstHopTarget` | **2 / 4**，两者都是 **`unreachable`**（`NO_BOUNDED_CORRIDOR`，8 个 entrance 无一产出首跳） |

**结论：B（把实测横扫接进前庭路径）本轮不做，证据不支持。**
按既定判断标准——`unreachable` 意味着"到那块地没有路线"，此时一个 16 m 的横扫跳正是**触手路**；
而另一半 anchor 根本不是 frontage 问题，是**地被占了**，横扫更救不了。

**两条必须先说清的探针保真缺口**（免得下一轮误读这份数字）：
1. 探针**没有先跑生产的 protected 预过滤**（`selectGrowableFrontageFootprint` + protections + ownership，
   `project-admission.ts:1672-1679`）。生产只在预过滤**为空**时才调用分类器，所以 `CLAIMED` 在探针里
   是"存在自有可划 footprint"，不必然等于生产会说 CLAIMED。
2. 那两个 `MISSING_FRONTAGE` anchor 的 `landCenter` 回退到了**瞬态 project 目标**（距离 1413 m / 458 m），
   所以它们的 `unreachable` 有距离成分，不完全是地形真相。
   **要干净数字，下一轮需要在探针里补上 protected 预过滤 + 用 Goal 自己的 targetPoint。**

**C 顺带查到的线索已被证伪（2026-10-02 只读核查）。**

初看：durable 里 37 个 `EXPAND_*` work order 的 `releasedReservationAt` 仍为 null（其中 **17 个带保留地 scope**），
且它们聚成两簇、当前 ring 的 anchor 正落在簇里，看起来像"增长域自己占着自己的地"。

**这是错的，`releasedReservationAt == null` 不是持地谓词。** 生产读的是
`isGoalWorkOrderReservationProtected` → `#goalWorkOrderHoldsClaim`（`durability.ts:2441-2465`）。
按该谓词逐条复刻：

| 集合 | 仍持地 |
|---|---|
| `EXPAND_*`（37 个） | **0** |
| 全仓 work order（90 个） | **1** —— 只有那个 `status:"ACTIVE"` 的 `PROVIDE_SERVICE:electricity` |

原因：COMPLETE 分支先看"未结命令"（这 37 个**全部为 null**），再看
`goalWorkOrderReachedMilestone`（`durability.ts:327-332`：`project.status === "COMPLETE"` 或
`tranche.stage === completionStage`）—— 那 14 个停在 `ZONED_WAITING_FOR_BUILDING` 的，
`completionStage` 就是 `ZONED_WAITING_FOR_BUILDING`，**相同即视为已达**，于是**claim 结束**。

**为什么字段还是 null（Q4 的答案）**：`recordGoalWorkOrderProgressionOutcome`（`durability.ts:2556-2570`）
对 `BLOCKED` **和** `COMPLETE` 都写 `status`，但**只对 BLOCKED** 写 `releasedReservationAt`
（2568-2570）。COMPLETE 的 claim 由里程碑谓词结束，不需要这个字段——所以 null 是**设计如此**，不是泄漏。
`#releaseReservationIfReconciled` 也只被 `#releaseDisplacedSuspensions`（仅 SUSPENDED）和位移槽调用。

**结论：这 37 个未释放记录是 durable 膨胀，不是 land lock**——14.7(3) 对 electricity 的结论同样适用于增长域。
**不要把 TARGET_PARKED 归因于它们。** 顺带确认：这 37 个里**没有任何一个**有未结 command（`unresolvedCommands` 全 null），
也没有未完成施工（COMPLETE / 终态 BLOCKED）。

### 15.3 探针对齐生产口径后的重测（2026-10-02）——真正的原因

第一版探针有**四处保真缺口**（都没先跑生产的 protected 预过滤；把瞬态 project target 当 `landCenter` 回退；
按 baseline 的 4 个 anchor 而不是 pace 的 8；`CLAIMED` 只是分类器默认标签）。对齐后（policy 直接由
`growthPacePolicy(V2_PROJECT_ADMISSION_POLICY, FULL_PACE)` 拼出；**增长 Goal 无 `targetPoint`**，实测
37 个 `EXPAND_*` 记录里 0 个有该字段，所以 ring 不按目标排序、`landCenter` 也不回退到远处）结果如下。

**ring:4 个 anchor、9 个自有本地路节点**（`maxAnchors=8`，但 192 m 分离度把 9 个节点塌成 4 个）。

| anchor | 前端格 | 无保护 footprint | 有保护 footprint | 分类 |
|---|---|---|---|---|
| `(-183.7, 41.7)` | **0** | 0 | 0 | `MISSING_FRONTAGE` |
| `(1095.0, 538.8)` | 41 | **8** | **0** | `CLAIMED_BY_EXISTING_RESERVATION` |
| `(663.4, 574.6)` | **0** | 0 | 0 | `MISSING_FRONTAGE` |
| `(916.7, 632.7)` | 16 | **8** | **0** | `CLAIMED_BY_EXISTING_RESERVATION` |

**两个 CLAIMED anchor 的 8/8 footprint 全部被同一个 scope 移除**，逐条量过（`withinReach=True`）：

```
intent:gate1-goal-work-order:abf45cb4…:project:starter-residential:district:1:tranche:1:reservation
```

**就是当前那个 ACTIVE 的 electricity 项目自己的 reservation**，而且它的 scope 半径是 **180 m**
（`reaches = 半径 + target.radius`：204−24 = 180，212−32 = 180），不是先按 `tranche.target` 看到的 28。
被移除的候选到它的距离是 **43.3 / 46 / 75.6 / 99.5 / 107.2 / 122.9 / 162.2 / 172.5 / 177.8 / 179.8 / 185.6 / 187.2 m**
——全在 180 m 球内。**它解释了 4 个 anchor 里的 2 个（不是 1 个）。**

**另两个 anchor 是另一种病**：`frontageCells = 0`（连一个临街格都没有），且无 `missingFrontage` 地、
无干净格。于是生产那条回退链（`project-admission.ts:1748-1752`：`missingFrontage.center ?? targetPoint
?? 清晰格心均值 ?? anchor`）退到 **`landCenter = anchor` 自身**，走廊 planner 随即返回

```
corridor ALREADY_REACHED: the target is 0.0m away, inside one cell; 0 entrance(s) considered, none produced a first hop
```

——一个**退化查询**：让路网从 anchor 出发去够它自己。该 anchor 贡献一次拒绝，且它什么也没证明。

**为什么 live 报的是 `MISSING_FRONTAGE` 而不是 `CLAIMED`**：`mergeGrowableAbsenceReports`
（`site-selection.ts:632-636`）按**阶梯取最强项**，`MISSING_FRONTAGE` 排在
`GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION` **之前**。所以一个混合 ring 的真实主因（占地）
被阶梯**盖住**了——这正是"直方图/标签回答不了真问题"的又一例。

**结论（因果，非推断）**：
1. **主因**：一个**永远 ACTIVE** 的 utility 项目，凭 180 m 的 reservation **消毒**了 ring 里所有还有
   前庭的 anchor（2/4）。它 ACTIVE 的根因是 14.5 那条——base utility goal 不能划 ZONING，产不出自己在等的建筑。
   A 只修掉了它**烧模拟窗口**，没修掉它**永不完结**。
2. **次因**：另 2 个 ring anchor 只看得到已建满的地（0 临街格、0 干净格），而生产对这种情况会发一个
   退化走廊查询（`to = from`），必然失败。
3. **规模**：`ownedLocalRoadNodes = 9` —— 自有本地路网只有 9 个节点，ring 能看到的入口本来就极少，
   再被 180 m 球盖掉两个。

### 15.4 Growth Frontier 闭环：anchor 契约（2026-10-02，已落地）

用户把这一轮的靶心重定义为**一个闭环**，而不是继续逐个消灭 rejection：

```
没有现成 frontage → Mayor 主动修一条合理的扩张道路 → 新 frontage 出现 → 立刻继续下一批施工
```

**闭环断在一个契约上，不是一堆 blocker。** 增长选择器的 anchor 只取 **native** 路：

`site-selection.ts:312-316`（改前）——`ownedLocalRoadEdges` 要求 `edge.native`，节点侧另有 `node.native`（`:362-364`）。

真实 scan 实测（`cs2-session:d8413e4f…`）：

| 类别 | 数量 |
|---|---|
| native local 边（地图自带） | **8** |
| **非 native local 边（Mayor 自己修的）** | **42**（Medium Road 37 / Small Road 5） |
| 非 native 且有主节点 | **38** |

**产品自己修出的 42 条路、38 个节点，对它自己的增长选择器完全不存在**——修路不可能让 frontier 往外长。
同一子系统早已有正确规则并写了三处（`gate1-progression-boundary.ts:628-635`；`buildableRoadEdge`，`site-selection.ts:764-766`）；
`SpatialRoadEdge` 的类型注释自己就写着 **"Native is only origin metadata"**。§11.1 也早已据此踩过同一坑。

**第 0 步（先验证闭环第二半，只读）**：`growableFrontageCells` 要求 `hasGrowableRoadsideWitness`
（`cell.roadside || roadLeft/Right/Back`，来自**原生扫描**）。新增 `tmp/probe-roadside-after-road.ts`，
在 Mayor 已修到、**距任何 native 路 322.9 m** 的路段旁取 detail：

| | |
|---|---|
| 96 m 内格数 | 591 |
| `roadside: true` | **263** |
| 距 **native** 边 ≤18 m 的格 | **0** |
| 距**自建**边 ≤18 m 的格 | 435，其中 `roadside` **263** |

→ **产品自建路确实产生 roadside 前庭**（且该处附近根本没有 native 路）。机制成立，才继续改契约。

**改动（只动 2 个文件的生产逻辑）**：
- `ownedLocalRoadEdges` → `!deleted && !temp && !divided && buildableRoadEdge(edge, availableRoadPrefabs)`（与三处先例同规则；
  `divided` 保留为**本地路语义**的收窄，不是授权判断）；
- `selectGrowableSearchAnchors` 新增可选 `availableRoadPrefabs`（不传 = 旧行为）；
- 节点侧去掉 `node.native`（节点只能经 `incident` 进来，而 `incident` 只由已过滤的边构造）；
- 生产调用点 `project-admission.ts:1642` 传入作用域内已有的 catalogue。

**边界 2：消除退化走廊查询。** `landCenter` 的链原本以 `?? anchor` 结尾，于是一个"名下没有干净地、
没有 `missingFrontage`、没有 targetPoint"的 anchor 会把 `from === to` 喂给 planner，得到
`ALREADY_REACHED: the target is 0.0m away, inside one cell`——**一个伪造的 corridor 失败**。
去掉该尾，改为复用既有的 `continue`（"这个 anchor 没有课程"），不新增机制/reason/durable 写入。

**修后只读对比**（`tmp/probe-frontage-refusal-class.ts`，已同步 catalogue）：

| | 改前 | 改后 |
|---|---|---|
| `ownedLocalRoadNodes` | 9 | **47** |
| `anchorsInRing` | 4 | **6** |
| **`SELECTABLE` anchors** | **0 / 4** | **3 / 6** |
| 退化 `ALREADY_REACHED` 查询 | 2/4 | **0**（如实报"没有可开的具名土地"） |

三个可选中的 anchor 全在 `x≈1198–1424`——**正是 Mayor 自己修出去的那片**。那个 180 m 占地 anchor 仍在（§15.3 E.2），
但已不再 binding。

测试：`111 suites / 1835 tests` 全绿（基线 1829 + 6：ring 4 条 + admission 2 条，含**反事实**与**边界 2 反向断言**）；
`tsc --noEmit` **646** 与基线逐条相同。

**live 验收（2026-10-02 00:58，6 tick）——闭环转起来了**：

| 指标 | A 轮（契约修前） | 本轮 |
|---|---|---|
| `GROWTH_POLICY_ADMITTED` | 0 | **36** |
| `GROWTH_POLICY_ALL_DOMAINS_REFUSED` / `TARGET_PARKED` | 10 / 10 | **0 / 0** |
| tick 结果 | 4/4 卡在 WAITING | **6/6 全部 `reached ZONED_WAITING_FOR_BUILDING`** |
| `visibleMutationCount` | 0 | **11** |
| `roadSegments` | 0 | **5** |
| `zoningActions` / `zoningCellsRequested` | 0 / 0 | **6 / 8429** |
| `facilityActions` | 0 | **0**（未伪造 utility 完成） |
| 世界 nodes / edges | 409 / 416 | **413 / 421** |

**新增的 5 条路全部 `native=false`（产品自建），全部落在 `x≈1293–1391, z≈399–557`** ——
正是 ring 新看到的那片前沿（新 anchor `(1197.6,469.2)`、`(1424.4,469.3)`）。**路是从产品自己的网络端往外修的**，
随后 6 次 zoning 吃掉 8429 格。这就是要求的画面：**没有前庭 → 主动修路 → 新前庭 → 继续施工**。

**诚实的边界**：
- 新路段在**既有产品前沿簇之内/周边**（既有自建路最远到 x≈1424）。老城核心在 `x≈-200..45`，
  所以方向是对外的；但 6 tick **不足以**证明"包围盒单调外扩"，只能证明闭环在跑、且修的是前沿不是内城重建。
- `population 42 → 42`：zoning 刚发生，建筑是**已建未入住**（`builtButVacant` residential 3 / commercial 19 = 22），
  填充要等游戏自己的节奏。所以"新前庭 → 施工"这一段在**划区**层完成，长房子那一段属于模拟。
- 订单 90 → 101：每 tick 派生的 goalId 都不同（facts 变了），这是 §15.2 那条 identity churn，仍未做；
  区别是它们现在**能完成**（`ZONED_WAITING_FOR_BUILDING`）而不是堆成 BLOCKED。

**长跑认证（2026-10-02 01:09，请求 12 tick / 实跑 7 tick）——两通过、一不通过、一未证**：

`GROWTH_POLICY_ADMITTED` ×47 + `DOMAIN_SWITCH` ×3（无一次 `ALL_DOMAINS_REFUSED`）；
`roadSegments` 5、`zoningActions` 6 / 8952 格、`facilityActions` 0；世界 nodes 413→417 / edges 421→426。

| 问题 | 结论 |
|---|---|
| ② 新 Road 是否持续成为后续施工的 anchor | **是**。7 tick 新增 5 条路**全部 `native=false`**（产品自建）；按 durable 命令的 `idempotencyKey` 逐条还原几何与时间，**4 次接续里 3 次在 60 m 内接着前一条的末端**（一次 0 m，同起点换方位）。ring 确实在用它们（`ownedLocalRoadNodes` 9→47、`SELECTABLE` 0→3）。 |
| ④ identity churn 是否已造成运行退化 | **本窗口内没有**。每 tick 墙钟 89.7 → 89.9 → 79.3 → 80.6 → 84.4 s（平），订单稳定 **+2/tick（线性，不加速）**，`simulationRunCalls` 8 / 7 tick。 |
| ① 建设范围是否单调向外扩 | **否**。产品自建路的包围盒与 `maxR` 两轮都**完全没变**：`maxR=1050.8`、`bbox x∈[-64,1424], z∈[-248,668]`。本轮 5 条路的半径只有 **461–549 m**（距 native 网质心），
落在既有前沿簇**内部**；而且东侧极值从上一轮的 x≈1391 **回退**到 1355。**最近的施工在"填"一个簇，不是在推外包围。** |
| ③ 局部等待时其他区域是否继续施工 | **未证**。本轮没出现 utility 等待；tick 6 是 `NO_FEASIBLE_GATE1_ROAD_CANDIDATE`（native 拒绝路候选，§三/§11 那条已知稀疏性），tick 7 以 `Save failed: LIVE_GROWTH_RUN_FORBIDS` 中止——**7/12 tick 就结束了**。 |

**因此不宣告 PASS/FROZEN**：闭环机制确实在滚（②④成立），但①"地图明显向外扩"**未被证明**，
且长跑早停于 runner 的 save 守卫。定因不在 anchor 契约（那已被证明有效），而在"选中的前沿点在哪"——
本轮 admission 反复选同一个东侧簇，没有把 frontier 推到网络最外端。

### 15.5 世界时钟自会话开始就没走过——第二个未接守卫的模拟驱动（2026-10-02，已修）

**这一条推翻了 §15.4 的一整类结论，先记在最前面。**

整个会话里我四次读到**同一个** `frame=11121294`、`gameTime=2026-01-09 07:14`，跨越三次 live 运行
（6-tick、12-tick 长跑、以及全部探针）。长跑里 `cs2_run_simulation` 调了 **8 次**，
而 `cs2_read_blocking_modal` 调了 **0 次**。

**现场**：一个里程碑弹窗正开着——
`modalClass: KNOWN_SAFE_DISMISSIBLE_MODAL`、`{kind:"PROGRESSION_MILESTONE", entity:{328,1}, milestoneIndex:2, isVictory:false}`、
`active:true, visible:true`。里程碑弹窗会**立刻暂停游戏**（§12.4 已记录）。

**决定性实验**（`tmp/probe-modal-and-sim.ts`）：
```
BEFORE frame=11121294 paused=true gameTime=2026-01-09 07:14
dismiss → {ok:true, action:"cs2mcp.milestone.dismissExpected"}   MODAL_AFTER_DISMISS = NO_MODAL
cs2_run_simulation {hours:0.5,speed:4} → {running:true, startFrame:11121308, targetFrame:11126769}
AFTER  frame=11121316  gameTime=2026-01-09 07:15
```
**消掉弹窗后世界立刻开始走。** 所以"地图不长、人口 42→42、bbox 不动"**不是 Mayor 的选择结果，是世界被按住了**。

**根因**：`v2/main-adapter.ts:6616` 的 `progress` 回调**直接**调 `cs2_run_simulation`，**没有走守卫**——
这是 §12.4「修在咽喉处」时**漏掉的第二个模拟驱动**。那次修复只挂在 `main-adapters.ts` 的 `runSimulation`，
而 live 增长跑的模拟窗口走的是 V2 foundation 这条。教训还是同一句：**要挂在每一个驱动上，不是挂在大多数上**。

**修法**（最小、复用既有模块）：在 `createV2FoundationPorts` 里用同一个
`createBlockingModalRuntimePort({ call: callTool })` 构造守卫，并在提交模拟前 `check(signal)`；
不允许继续时抛 `blocking_modal_guard:<class>`（fail-closed，与另一条驱动一致）。
修后 `111 suites / 1835 tests` 全绿，`tsc --noEmit` **646** 与基线逐条相同。

**对已有结论的影响**（诚实定级）：
- **作废**：§15.4 的长跑认证里"建设范围没有外扩 / infill 饿死 frontier"这一类判断——**世界无法扩张时这些量不出来**。
  同理 §15.1 里"reservation 压在建筑上"仍是静态事实，但"城市不施工"的读数要重新量。
- **仍然成立**：A（utility 等待不烧模拟预算，靠调用计数与 tick 完成度验证）、
  前沿 anchor 契约（ring 9→47、SELECTABLE 0→3、路真的建出来、策略翻成 ADMITTED）——这些都不依赖时钟。
- **待重测**：一切与"城市在长"有关的验收（人口、建筑、外包围、10 万人口刹车点）都必须在时钟活了之后重做。

**修后复验与第二层真相**（6-tick live，2026-10-02）：报告里 `cs2_read_blocking_modal` **仍然是 0**，
`cs2_dismiss_blocking_modal` 0，`blocking_modal_guard:` 0，而 `cs2_run_simulation` **6 次全部是 `{cancel:true}`**
——**整个运行里一次提交都没有**，所以帧停在 11126772、`gameTime` 停在 07:44。
即：我打的 `progress` 回调**根本没被执行**。

于是这里是**两个独立缺陷**，必须分开记：

1. **弹窗阻塞模拟（已证、已修）**。消掉弹窗后直接提交 `{hours:0.5,speed:4}`，帧 11126772 → 11126798、
   `gameTime` 07:44 → 07:45。守卫补在 V2 foundation 的模拟驱动上（与 `main-adapters` 的 `runSimulation` 同一模块），
   **这条修法仍然正确且必要**——只是本轮没有执行到它。
2. **A 修完之后，增长循环不再提交模拟**。§15.2 的 A 让 utility 等待不再买窗口，而每个 tick 靠**静态 mutation**
   （修路 / 划区）就到达 `ZONED_WAITING_FOR_BUILDING` 并收工，**世界从不被推进**。
   6 次 `cancel` 是收尾的 park，不是窗口。**这才是当前"城市不长"的主因**，
   而且它直接撞产品语句：**"不能把产品重新限制成'划区后慢慢等游戏长房子'"**——现在是"划完就走，世界一秒没走"。

**两处修复后的 live 复验（6 tick，2026-10-02）——世界活了**：

| 指标 | 修前 | 修后 |
|---|---|---|
| `cs2_run_simulation` **提交** | **0**（6 次全是 cancel） | **4**（+6 次收尾 cancel） |
| `cs2_read_blocking_modal` | **0** | **4**（V2 驱动上的守卫真的在跑） |
| 帧号 | 11121294，整会话不动 | 11132234 → **11156347** |
| 游戏时间 | 停在 07:14 | 08:14 → **10:27** |
| 人口 | 42 → 42 | **40 → 42**（本会话第一次动） |

其余产品面照常：`visibleMutationCount` 7（3 段路 + 4 次划区 / 5700 格）、`facilityActions` 0（未伪造 utility 交付）、
策略继续 `ADMITTED`。tick 1/3 仍是 `NO_FEASIBLE_GATE1_ROAD_CANDIDATE`（§三/§11 那条 native 拒绝路候选的已知稀疏性，非本次引入）。

**待办（下一步的主线）**：让世界跑得足够多，使"划过的地"真正变成"看得见的城市"（人口/建筑曲线），
并修 runner 的计数口径：`simulationRunCalls` 按名字数会把 `cancel` 也算成一次窗口（本次 10 次里 6 次是 cancel）。

### 15.6 轴对齐网格：认证率实验与零成本再分析（2026-10-02，只读）

**目标改判（用户冻结）**：本阶段验收只有一条——**一条路两侧大量建筑，有水有电有污，然后继续下一片**。
云端 AI、DEMOLISH、速度模式、十万人口刹车**本阶段冻结**。此前所有 BEFORE/AFTER 对比**作废**（世界时钟冻结所致）。

**实验**（`tmp/probe-axis-grid-certification.ts`，只读，全为 native dry run `preflight`）：

| 锚类型 | 探针 | 可认证 | 比例 | NO_PROPOSAL_EDGE | PLACEMENT_REFUSED |
|---|---|---|---|---|---|
| 节点锚（START 绑定） | 144 | 26 | **18.1%** | 52 | 66 |
| 边上分割点锚（不绑定） | 360 | 25 | 6.9% | 157 | 176 |

**裁决：分割点锚路线终止**（与 native Junction no-effect 同一风险区），**只用节点锚**；
"四方位无偏置""约一半失败可靠平移救回"两条结论**撤回**（样本不足、节点间差异远大于方位间）。

**零成本再分析**（`tmp/analyze-axis-grid.cjs`，读旧结果 + 新 scan，零探针）：
**join 只有 10/12 个 anchor 对上新存档**（城市已重载，`generation 45390cd5… → 5cc5f4d1…`），
且探针本就取自旧 generation——**样本对强结论不合格**，这也是撤回成立的独立理由。

分层后发现一条**比原假设更可靠的信号**：**两类拒绝与"相对入射边的夹角 / 长度"强相关**——
`0-10° 共线`：NO_PROPOSAL_EDGE 20 vs PLACEMENT 7；`60-80°`：NO_PROPOSAL_EDGE **0** vs PLACEMENT 9。
长度上：`16m`：NO_PROPOSAL 25 vs PLACEMENT 8；`24/40m`：约 10 vs 20。
即**"短 + 共线 → 连边都形成不了"、"长 + 近垂直 → 边形成了但地面拒绝"**——
这正好是生成器该读的"该换方位还是该挪位置/改长度"信号。原假设（可认证方位由相对几何决定、与绝对方位无关）**未被支持**：
相对角分层没有单调序，绝对方位反而有 0.10/0.167/0.30/0.267 的差异。

**基线重建**（`tmp/probe-baseline.ts`，只读，重载后）：
`worldId cs2-session:d8413e4f…`、`generation 5cc5f4d1…`、`gameTime 2026-01-10 06:19`、paused；
**人口 50**、建筑 98。
**需求**：residential `householdDemand 55`（low/med/high = 0/100/0）、**commercial `buildingDemand 0`**、
industrial `53`、office `100`。**劳动力**：`employed 25`，而 `freeByEducation` 有 61/67/51/20/6 的富余——
**不缺工人，是过剩**。
**增长选择历史**（durable ledger）：`PROVIDE_SERVICE 65`、`EXPAND_RESIDENTIAL 25`、
**`EXPAND_COMMERCIAL 14`**、`EXPAND_INDUSTRIAL 14`、`UTILITY_SERVICE 5`、`EXPAND_OFFICE 4`。
即**商业被选了 14 次，而当前商业需求为 0**——选择依据不是 demand。
机制候选：`generateLocalMayorGoals` 的 warrant 还接受 `reserveDeficit` / `hasExpansionRoom` /
`maintain_development_reserve`（`local-mayor/decision.ts:429-453`），**待用一次读确认是哪一条**。

**未读到**：`cs2_list_buildings` 返回的建筑**没有 `warnings` 字段**（我假设的形状不存在），
所以"逐栋警告类型（电/水/污/员工）"这一项**本轮没拿到**，需要换读取路径。

### 15.7 第一个"有水有电有污"的样本（2026-10-02，已在存档上完成）

**验收达成**（`consumerService` readback，独立复验两次）：

| | 修前 | 修后 |
|---|---|---|
| 全城 `servedAllThree` | **0** | **27** |
| 西群 27 栋 | 电 27 / 水 27 / **污 0** | **电 27 / 水 27 / 污 27** |
| `maxPollution` | 0 | **0** |

**读路径（这一轮最重要的收获）**：服务状态的权威字段是 **`consumerService`**，不是 `connectors`。
`cs2_utility_connectors` 的 `semantics` 自己写着 `consumerSource` = "building 的 ElectricityConsumer /
WaterConsumer 组件状态"，且"**调用者不得从全局容量推断**"。读 `connectors` 会把**每一栋已服务的楼都读成未服务**
（本轮我因此得出过"40/40 缺水"的错误结论，已作废）。

**做法（三步，全部复用既有机制，未新增原语）**：
1. **就近放排污口**：在离西群 300 m、**离抽水站 594 m** 的水体岸点放 `SewageOutlet01`
   （`place_building`；水体采样确认该处水深 24 m，抽水站是**地下水**站，拉开距离避免污染取水）。
2. **沿街铺污水管**：`Small Sewage Pipe` 沿**西群自己那个道路分量的 9 条街**（共 596 m）铺，
   而不是横穿空地走直线——**第一版直线干线铺了 8 段、管线确实建成（排污口连接边里能看到 `Small Sewage Pipe`），
   但楼的 `sewageConnected` 不动**；覆盖是**跟着街道走**的，抽水站那条供水管的 `connectedEdges` 正是一条 `Small Road`。
3. 跑一个模拟窗口让游戏重算连通性（`consumerService` 是活状态，暂停时不刷新）。

**顺带确认的关键事实**：
- **`cs2_build_road` 能建管网**：prefab 域是 `category road or net`，net 类里有
  `Small/Large Water Pipe`、`Small/Large Sewage Pipe`、`Combined Small/Large Pipe`、`Low-voltage Ground Cable`。
  产品**建过**（durable 里 `UTILITY/build_road` + `Low-voltage Ground Cable`，`OBSERVED_MATCH`）。
- **产能从来不是瓶颈**：水 23688 / 污 100000 / 电 13466，用量都在几百。
- **路网是 112 个连通分量**：西群所在分量 10 节点、东群所 43 节点，两者最近节点相距 **1121 m 无路**。
- **密度词表缺口**：catalogue 里 LOW 6 个、MEDIUM 1 个、**HIGH 0 个**；而 `readResidentialZone`
  （`main-adapters.ts:2816-2823`）用 `zoneTypes.find(...)` **按目录顺序取第一个**，
  所以**即使高密度解锁，产品也仍会建最低密度**。建筑 prefab 本身 L1–L5 全未锁（746 抽样里 locked 0）。

**仍未做**：东群 49 栋（电 0 / 水 0）——需要先连通那 1121 m 路网缺口，或从别处引电引水；
管线作为新 command family 进产品（本轮是脚本，未进生产代码）。

### 15.8 待办：把"沿街覆盖铺管"提升为常驻能力（设计已定，本轮**未落代码**）

**为什么未落**：这是一笔要动道路内核授权/对账的生产改动，而本轮会话已到尽头——
**在没有余量写测试并跑通的情况下把改动塞进正在工作的道路路径，是我这一整轮一直在避免的事。**
所以这里交的是**可直接执行的交付单**，不是半成品。

**能力定义（advisor 第 1 条）**：
> 输入 = 一个街区的**道路分量**；输出 = 覆盖该分量**所有街道**的管线；**每条街各自 readback**。

**形状**：
- 新模块 `v2/utility-network-laying.ts`，**复用 `createV2RoadKernel`**（同一 `submit` / 授权 / Apply-once / 对账），
  **不另造第二套**。每条街 = 一个独立命令（自己的 commandId、自己的 readback、自己的对账），与 durable 里
  已有的 `UTILITY/build_road` + `Low-voltage Ground Cable`（`OBSERVED_MATCH`）**同一机制**。
- 命令族：`actionFamily: "UTILITY"` + net prefab；prefab 域已确认是 `category road or net`。
- 输入端口：道路分量的边集（`connectedEdges` 连通分量）+ prefab（`Small Sewage Pipe` / `Small Water Pipe` /
  `Low-voltage Ground Cable`）+ 每条边的起讫点。输出：每条街的 `{edgeRef, commandId, status, readback}`。
- **它不决定"给哪个街区铺"**——那是计划层的事。这一层只兑现"把这个分量的每条街都铺上管线"。

**哪个旧 Authority 失去权力**：`ROAD/build_road` 不再是唯一能建 net 对象的通道；
`greenfield-utility-bootstrap` / K05 那条"只放设施、从不铺街面覆盖"的路径**不再是 utility 交付的唯一出口**。

**净增删行数**：**尚未实现，因而没有数字**——按 §15.7 的做法，实现时应是一次净增（新模块 + 测试），
除非同时把 K05 的旧覆盖路径删掉，那才会出现净删。**我拒绝在没实现时编一个行数。**

**未确认（单列）**：
1. 道路内核的 `effectMatcher`（`createAuthoritativeRoadEffectMatcher`）**是否认管道落成**——管道是 net 边，
   拓扑形状类似，但**没有实测**；这决定 readback 是"复用"还是要单写一个 matcher。**这是实现第一步要先测的**。
2. 管线的 `roadOperationKind` 取值是否被 native 接受（本轮用裸 `cs2_build_road` 直调，**没走内核的授权路径**，
   所以内核路径下的行为**未验证**）。
3. 东群 49 栋的**干线源头方案**（设计未给）：东群分量 43 节点，自身无电无水；最近的电源是两座风机（490/724 m），
   水源在 822 m 外；**是否要在东群就近放设施，需要先做与西群同样的只读选址**。
4. 西群那次是**脚本直调**，**没有** durable 命令、**没有**对账——所以"常驻能力"实现后，
   **西群那 27/27 是由脚本造成的既成事实**，不会自动进入产品的命令账本。

### 15.2 之后：14.2 的等待语义（identity migration，单独排一轮）

`UTILITY_PROVISION_PENDING` 那条链的"不生成 successor"根在 `goalId` 嵌 `:facts:<hash>`
（population/demand/treasury），即 `ai-mayor-control-plane-verdict` 里的 **OperationId 由意图而非世界事实派生**。
**动 durable 状态，需要边跑边看。** 先读 14.7（三条已查清、别重复查）与 14.2（验收标准）。

注意 14.7 已证伪"悬挂 work order 锁地"：43 个 electricity work order 里只有 1 个仍持保留地。

### 15.3 其他（不抢主线）

- `PLACE_BUILDING` 目前只给设施用；住宅/商业待 live 证明不破坏 renters/owner/demand 生命周期后再切。
- `UTILITY_CONNECT` / `DEMOLISH` 尚未进入本地意图词表（14.1 的五项能力）。
- 道路认证缓存尚未接进 `gate1-progression-boundary` 的选择器（模块本身已具备，见第十一节）。

### 15.4 环境前提（每次 live 都要）

CS2 在跑、Bridge `127.0.0.1:8642`、**世界必须暂停且 native Idle**（runner 硬检查
`LIVE_WORLD_NOT_PAUSED_READY_AND_IDLE`，没有开关）；
`npx tsx scripts/ai-mayor-continuous-growth-live.ts`，`AI_MAYOR_LIVE_TICKS` 控制 tick 数。

### 15.9 `CellFlags.Visible` 被当成身份键 —— 同一个洞的第三次（2026-10-02，谓词已按保守方案放宽）

**现象**：世界重载（`45390cd5` → `55038afe`）后，`confirmDescendantSaveReload` 对 ZONING 命令
`687c1f35` 返回 UNPROVEN，**整条 lineage 保持 quarantine，一切 durable 写入被封**（含产品自己的增长循环）。

**实测（只读 + 一次有界模拟窗口，未建任何东西）**：8 个授权格**全部在距离 `0.00 m` 处**存在、
类别正是 `residential` —— **世界是对的** —— 但 **8/8 `visible=false`**。
跑满 0.5 小时窗口（`frame 11418507 → 11423968`，`10:27 → 10:57`，自动暂停）后**一格都没翻**。
⇒ 不是 liveness，是这些格**真的丢了 `CellFlags.Visible`**。

**根因（同一个错位的第三次）**：`visible = (cell.m_State & CellFlags.Visible) != 0` 是**模拟逐帧写的状态位**，
被当成**身份判据**用。三次击中的形状：
1. 记录侧收 `visible`、当前侧不收 → 不可见邻格灌水 → `matches.length≠1`；
2. 修成"两侧都收" → 本轮；
3. **目标格自己丢了 `visible`，被当前侧自己的过滤删掉** → 假 INCONCLUSIVE（fail-closed，但封死整条 lineage）。

**已落地（保守方案，用户裁决）**：`ZONING_CELL_VISIBLE_UNCONFIRMED_METERS = 0.5`；当前侧匹配改为
① 容差带（1 m）内**唯一 visible 候选 + 类别正确** → 命中（原行为，不变）；
② 否则仅当**容差带内唯一候选 ∧ 距授权位置 ≤0.5 m ∧ 类别正确** → 命中，但计入 `visibleUnconfirmed`，
reason 写明 `… do NOT carry CellFlags.Visible, so their visibility is UNCONFIRMED`；
③ 其余 INCONCLUSIVE。**容差带内多个候选时 `visible` 过滤是终局**，不放宽。
4 个回归测试（可见命中无标注 / 不可见唯一命中带标注 / 0.4 m 与 0.94 m 两档灌水仍 INCONCLUSIVE / 可见目标旁的不可见闯入者仍不抢匹配）。

**效果**：血缘确认通过（activation 从 `DESCENDANT_CONFIRMATION_REQUIRED` 前进到 `DESCENDANT_CHECKPOINT_REQUIRED`）。

**待办（本阶段不动，服务覆盖 live 完成后排期）** —— `visible` 的三条更稳定判据候选（仅提议）：
1. **位置即身份**：授权位置本身就是 PRE_SUBMIT 精确坐标；`visible` 只作**消歧偏好**，不作必要条件（本轮保守方案的一般化）。
2. **换用不随模拟变的格属性**：`roadside` / `roadLeft` / `roadRight` / `roadBack` 与 block 几何由 block 重建时写入，比 `Visible` 稳定。
3. **拆开两个事实**：把"格是否还在"与"格是否可见"分成两个字段各自记录，不合并进一个布尔。

### 15.10 durable 激活的 checkpoint 要求：产品不允许脚本存档

`DESCENDANT_CHECKPOINT_REQUIRED` 之后，`ensureDurableWorldOnce` 走
`findLoadedWorldSave` → `findAvailableWorldSave(matchesWorldSave)` → 没有可用存档时，
**只有 `automaticRecoverySave === true` 才提交 `cs2_save_game`**；否则返回
`DESCENDANT_USER_SAVE_REQUIRED: … save the city, then re-run the durable recovery`。
原文理由：*"the save and the rollback point are the user's to choose … rather than turning a durability gap
into an unrequested save of the player's city."*
**所以正解是"玩家存 → 重跑"，不是让脚本存。**

顺带两条 MCP 适配事实（脚本层，非产品缺陷）：
- 该 MCP server build **不暴露 `cs2_saves`**；桥有 `/game/saves`，字段与 `findLoadedWorldSave` 需求逐项吻合，已在脚本里垫上。
- **不暴露 `cs2_save_status`**；桥的 `/game/save/status` 返回 `lastSaveRequestId`，
  而代码读 **`saveRequestId`** —— **字段名不一致，垫片会撒谎**，故未垫。

**澄清（2026-10-02 实测，**推翻**上面这条是"桥的缺陷"的读法）**：
`findLoadedWorldSave` 之所以认不到存档，根因是**崩溃后那次加载的上下文本身是坏的**，不是桥不会回答。
证据：`/game/saves` 的 `loadedSaveMetadataAssetGuid` 当时是 `05413337…`，而它**在 231 个存档里一条都不存在**（幽灵 guid）；
`isLoadedSave === true` 为 **0 条**。**一次干净的 Load 之后**：`loadedSaveMetadataAssetGuid` 变成
`5fd39f82…`（= 刚加载的那个档），且**恰好 1 条**存档 `isLoadedSave === true` 且与它一致。
⇒ **`isLoadedSave` 只在"从存档加载进入"后置位，"游戏内存档"不置位；桥的行为是正确的。**
**⇒ 不需要改 C# mod。** 历史遗留：账本里两个 durable checkpoint（`b657016f…` / `1feff148…`）引用的存档
**都不在盘上**，是悬空引用，未查去向。

### 15.11 §15.8 的能力已落地（2026-10-02）

§15.8 的"设计已定、本轮未落代码"**已作废**。落地形状（**A 方案**，用户裁决）：

- **观察契约**（`v2/foundation.ts`，加字段，ROAD 路径零变化）：
  `V2ObservationEnvelope.sources.netEdges?`（**非必需来源**，不入 `required`，动不了 coherence）、
  `V2ObservationReaders.readNetEdges?`、`capture({ netEdgePrefabs? })`、`RoadEffectMatcher.netEdgePrefabs?(command)`。
- **net 边 matcher**（新模块 `v2/utility-network-laying.ts`）：
  `createNetEdgeCourseEffectMatcher` **按 prefab 分派** —— 管道走 net 列表（`cs2_list_roads` + 复用既有原语
  `matchNetworkLinkCourseEffect` + 完整性契约），其余原样交给 ROAD matcher。
  `createV2RoadKernel` **一个实例两个视图**（不另造第二套）。
  另有 `planUtilityStreetsAlongComponent` / `layUtilityAlongRoadComponent`（分量边集 → **每条街一个独立命令**、
  独立 commandId、独立 readback；第一条非 MATCH 即停）。
- **live 驱动**：`scripts/ai-mayor-utility-laying-live.ts`（默认**只读 plan**；`--apply` 才写）。
  只读 plan 实测东群分量（47 节点 / 54 街 / 2322 m）：**污 `Small Sewage Pipe` 54/54 可认证**、
  **电 `Low-voltage Ground Cable` 53/54 可认证**（唯一被拒 `78775:1`，97m Small Road，`valid=false/validNewProposal=false`，
  属"边形成不了"那一类）。两条木桥路段与 169m Gravel 长段**均可认证**。
- **仍未做**：东群的 `apply`（一条街都还没建）、**水**（需就近 `place_building` 抽水站，属另一原语）、电的 `78775`。

**两个 MCP 适配事实（脚本层，非产品缺陷）**：该 MCP server build 不暴露 `cs2_saves`（已用 `/game/saves` 垫，字段吻合）、
不暴露 `cs2_save_status`（未垫，字段名不一致）。**产品自己的 live 入口用的是同一种薄适配器**
（`scripts/ai-mayor-continuous-growth-live.ts:106-111`，同样 `live--${name}`），所以"换用产品入口"不解决工具面缺口；
唯一完整工具面在 Electron 运行时（`main.ts` → `Container.inject(MCPToolsManager)`），不可脚本化。

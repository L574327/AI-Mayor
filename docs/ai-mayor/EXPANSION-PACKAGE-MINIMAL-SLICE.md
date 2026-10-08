# Expansion Package — 最小切片设计（不新增 framework）

> 目标：一个"包"= 一块地的**路 + 管线 + zoning 同批交付**，且**选址时就把三网可达性作为准入条件**。
> 全部复用现有入口；**新增的只有两个纯函数**（街道分配、三网可达判定），不加控制层、不加原语层。

## 为什么需要这个包（这次的实测教训）

东群是**分步**做出来的：先污(22 街) → 再电(33 街) → 水无街可铺（50% 封顶）。
分步的代价来自硬约束 #2：**每个道路节点只能承载一个 net 物体**，所以**先铺的吃掉节点，后铺的死路**。
⇒ 选址期就要知道"这块地三网各走哪些街"，否则第三个网注定做不成。

## 一、选址约束（新的准入谓词，纯函数）

给定候选地块 `P`（中心 + 半径）与权威扫描，要求**同时**成立：

| 条件 | 判据 | 复用 |
|---|---|---|
| C1 三网都能落地 | 水：`P` 内 owned 干地上 `groundWater>0 ∧ pollution==0`（≥1 个样本）<br>污：`P` 内 owned 岸线可认证 outfall，或既有污网可达<br>电：`P` 内或 160m 内可放 `electricityProduction>0` 的资产 | `planBootstrapUtilities(...,{utilityKind:"water"/"sewage"/"power", siteEnvelope})` `spatial/utility-planner.ts:1028`；`createWaterSiteConstraint` `v2/water-site-constraint.ts:351` |
| C2 **街道可三分** | 分量边集能分成三组 `S_water/S_power/S_sewage`，**每组每条 course 都能通过 native 预检**，且各自覆盖 `P` 内 ≥X% 的临街面 | **新增纯函数** `allocateUtilityStreets(edges, models) → {water, power, sewage}`：按"共享节点优先避开"贪心分区，**再用 `cs2_spatial {mode:"preflight", kind:"net"}` 逐条校验**，被拒的退回重分或计入缺口（~60 行，只读） |
| C3 地块合法 | owned ∧ 干 ∧ 坡度≤8%，且与既有建筑/保留区不冲突 | `onOwnedDryBuildableLand` `spatial/utility-planner.ts:260`；`cs2_spatial {mode:"preflight", kind:"object"}` |

**C2 的形态是被实测修正过的**（`scripts/tmp-street-allocation.ts`，东群分量 root `232259`）：
- 节点度直方图 `{1:14, 2:15, 3:13, 4:6, 5:1}`，**最大度 5**；贪心与 200 次随机序的**最优着色都是 5 色**。
- ⇒ **严格"两两不共节点"的三分不可能**。所以 C2 **不能写成图不变量**，只能写成"贪心分配 + native 逐条校验 + 缺口记账"。
- 佐证真规则更弱：污(22 街) 与 电(33 街) 事实上共存（并集 54/54，仅 `49054:3` 一条冲突），甚至有一对**共享节点**的桥上街道双双成功。
  ⇒ "节点只能承载一个 net 物体"是**大多数情况**，不是不变量；**唯一权威是预检**。

**C2 是这次唯一的新概念**，也是最便宜的：它只是分量边集上的一个确定性分区 + 只读预检，不碰 native 写入、不碰 durable。
它的输出直接决定后续每条 course 走哪条街。

## 二、一个包的执行阶段（顺序即约束）

```
P0 选址判定     C1 ∧ C2 ∧ C3 → 产出 {site, streetAllocation}
P1 道路         build_road 把 P 接进既有分量（服务路/接入路）
P2 三网设施     每网一个设施：planBootstrapUtilities(utilityKind) → executeSharedUtilityRecovery
P3 三网沿街     S_water/S_power/S_sewage 各自铺对应 prefab（每街一条 course，独立 commandId/readback）
P4 zoning       在 P 内画住宅/商业
P5 窗口+普查    consumerService 三网达标判定
```

**P2 与 P3 的顺序**：设施先放（它的连接 course 会占用少量节点），再按 `streetAllocation` 铺街 —— 分配表在 P0 就固定了，
所以 P2 的连接必须**只落在分配给本网的街上**（否则会把别网的节点吃掉）。

## 三、复用清单（file:line，零新增框架）

| 阶段 | 复用 | 位置 |
|---|---|---|
| 扫描/世界 | `parseSpatialBootstrapScan` · `buildSpatialWorldModel` | `spatial/world-scanner.ts` |
| 地形读 | `parseV2SpatialSiteDetail` | `v2/main-adapter.ts` |
| 三网选址 | `planBootstrapUtilities` · `selectStageAWaterPlan` | `spatial/utility-planner.ts:1028 / :915` |
| 选址准入 | `createWaterSiteConstraint` | `v2/water-site-constraint.ts:351` |
| 污 outfall 走廊 | `sewageAccessPrerequisite` · `planRoadCorridor` | `v2/water-site-constraint.ts:579` · `spatial/road-corridor.ts` |
| **路+管同批执行** | `executeSharedUtilityRecovery` | `v2/utility-recovery.ts:600` |
| 连接切分/候选 | `splitUtilityConnection` · `buildUtilityConnectionCandidates` | `utility-planner.ts` · `v2/utility-recovery.ts:480` |
| 预算 | `minimumFeasibleUtilityBudget` | `v2/utility-budget.ts:111` |
| **durable 记账** | `ports.greenfieldUtilityBootstrap.run()` → `executeScopedUtility` | `v2/main-adapter.ts:367 / 4371` |
| zoning | `cs2_mayor_execute_actions [{type:"zone",…}]` | 见 `scripts/ai-mayor-bootstrap.ts:354` |
| 街道铺网 | `planUtilityStreetsAlongComponent` · `layUtilityAlongRoadComponent` | `v2/utility-network-laying.ts:281 / :334` |
| 普查 | `consumerService` 逐栋读 | `scripts/tmp-east-group-utility-census.ts` |

**新增（非框架，两个纯函数）**：`allocateUtilityStreets`（C2）与 `threeUtilityReachability`（C1 的汇总）。
两者都不发 native、不写 durable，可单测。

## 四、最小切片的验收

- P0 必须**在放任何东西之前**就给出 `{site, streetAllocation}`，且 `S_*` 两两无共享节点（可在测试里断言）。
- P5 三网 `consumerService` 覆盖各 ≥ 80%（按消费者口径，生产设施不计入分母）。
- 全程账本可追溯：设施与网线走 `greenfieldUtilityBootstrap.run()`，铺街走既有 ROAD kernel。

## 五、与既有"分步"做法的差别（一句话）

**分步**：做到第三网才发现没有街了 → 封顶 50%。
**本包**：选址期就把"三网各走哪些街"算出来 → 第三网在第一锹土之前就有位置。

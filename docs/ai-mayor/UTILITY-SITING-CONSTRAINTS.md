> ⚠️ **部分过期（2026-10-02）**：本文件 §3 / §7 / §8 / §8b / §9 的距离与覆盖结论来自**旧世界** generation e53914edf19432498930c5149b3be02。
> 在新世界（30900619551d4170aac17b384e04cd75）已实测反例：**电 欧氏 325 m / 图距 556 m ⇒ 覆盖 0%**，就近放 50 m ⇒ 48%，且**沿街铺缆 48%→13%**。
> §8 的「600 m 内每网须有设施」对**水/污**仍成立（实测 94%），对**电不成立**。§8 的「排污口必须临水/本区无水体」是旧世界推得、未复证。
> 仍有效：§1 / §2 / §4 / §8a-0 / §10。完整对照见 DOC-INVENTORY.md §D。

# 公用设施选址与铺设：硬约束清单（一页）

> 全部条目都是 **live 实测**得出的，每条后面是给它背书的调用点或证据。
> Generation `1e53914edf19432498930c5149b3be02`，东群分量 `232261→232259`。
> **用法**：任何"给某片区域通水/电/污"的计划，先逐条过这张表；**违反任何一条，native 都会用
> `409 operation blocked by game validation (overlap, water, steep terrain, protected entity...)` 拒绝，
> 而这条消息不会告诉你违反了哪一条**（桥自己写着 `ValidationSystem ErrorData is job-local … no bounded
> proposal-scoped ErrorType surface is available`）。

## 1. 判服务只读 `consumerService`

`cs2_utility_connectors {index,version}` 的 `consumerService.electricity.connected` /
`consumerService.water.waterConnected` / `.sewageConnected`。
**绝不能读 `connectors`** —— 那是设施侧视图，会把每栋已服务建筑读成未服务（桥的 `semantics.consumerSource` 原话）。
`consumerService` 是**活状态**：世界暂停时不刷新，改完必须跑模拟窗口再读。

## 2. 一街一设施：**每个道路节点只能承载一个 net 物体**（与类型无关）

- 污占 22 街、电占 33 街，**并集恰好 54/54 街**（仅 `49054:3` 一条同时有两者）。
- 实测：`Small Water Pipe` 铺在**电缆街** `(1301.1,399.1)-(1323.7,391.1)` → 409；铺在**污街** → 409。
- ⇒ **三种管网不能共用同一条街**。第三条网必须靠"设施挂接"，不能靠"沿街铺管"。
- ⇒ **规划顺序有代价**：先铺的设施把节点占掉，后铺的（任何类型）全部被拒。**铺设前必须先分配街道。**
- ⚠️ **但它不是图不变量**：东群分量最大节点度 5，严格"两两不共节点"的三分需要 **5 色**（`scripts/tmp-street-allocation.ts` 实测，200 次随机序最优同为 5），
  **不可能**；而污(22)/电(33) 事实上共存、并集 54/54、仅 1 条冲突，还有一对共享节点的桥上街道双双成功。
  ⇒ 把这条当作**强经验规律**用，**唯一权威是 native 预检**：任何"按图论保证可行"的推论都是过强结论。

## 3. 水源 = `terrain.groundWater`，且是**有范围**的

`cs2_spatial {mode:"detail", x, z, radius, resolution}` → `parseV2SpatialSiteDetail(...).terrain`：
`groundWater[]` / `groundWaterPollution[]` / `waterDepths[]` / `heights[]` / `cellSize` / `bounds`。
过滤谓词（`spatial/utility-planner.ts:260 onOwnedDryBuildableLand` + 地下水段）：
`waterDepth ≤ 0.05 ∧ 坡度 ≤ 8% ∧ owned ∧ groundWater > 0 ∧ groundWaterPollution === 0`。
**地下水是斑块，不是全图**：东群西臂 planner 直接报
`groundWaterInEnvelope=0, withinRoadReach=0, nearestGroundWaterAnywhere=none` ⇒ **西臂无水可放**。
**绝不要用固定步长网格去"证明没有水源"** —— 1km 网格会跳过真实存在的斑块（曾因此得出错误结论）。

## 4. 选址与放置只有这些入口（不要自造）

| 环节 | 入口 | file:line |
|---|---|---|
| 扫描/世界模型 | `parseSpatialBootstrapScan` → `buildSpatialWorldModel` | `spatial/world-scanner.ts` |
| 有界地形读 | `parseV2SpatialSiteDetail` | `v2/main-adapter.ts` |
| 水选址 | `selectStageAWaterPlan` | `spatial/utility-planner.ts:915` |
| 水/电选址 | `planBootstrapUtilities(..., {utilityKind, siteEnvelope})` | `spatial/utility-planner.ts:1028` |
| 准入约束 | `createWaterSiteConstraint` | `v2/water-site-constraint.ts:351` |
| 放置+连接+校验 | `executeSharedUtilityRecovery` | `v2/utility-recovery.ts:600` |
| 预算上限 | `minimumFeasibleUtilityBudget` | `v2/utility-budget.ts:111` |
| **durable 记账** | `ports.greenfieldUtilityBootstrap.run()` → `executeScopedUtility` | `v2/main-adapter.ts:367 / 4371` |

## 5. 放置的两条路，账本后果不同

- `executeSharedUtilityRecovery` 的 `ports.execute` 直接打 `cs2_mayor_execute_actions`
  ⇒ **世界里生效，但 durable journal 不记**（`journalPosition` 不变）。回滚只能靠游戏档。
- `greenfieldUtilityBootstrap.run()` → `executeScopedUtility` ⇒ 构造 `V2CommandRecord{actionFamily:"UTILITY"}`
  并写 write-ahead（`main-adapter.ts:4866`），**带 `budget.authorizedMaxSpend`**。要留账就走这条。

## 6. 放置的机械约束

- `executeSharedUtilityRecovery` 的 `readCapacity` **必须按目标区域作用域**：返回全城读数会让它正确地早退 `no_action_needed`。
- 离路网远的站：**第一轮铺 service-road、第二轮才铺 direct-cable** —— 一轮跑不到 `attached=true`。
- `findExistingFacility` 按 **prefab + 计划位置 ±4m** 去重；plan 重算后位置会变，**匹配不上会重复放置**（东群现存两座抽水站即此）。
- 探针是**单线程**的：上一发未退净时会答 `another build operation is in progress` —— 那是争用，**不是判据**，必须退避重试。

## 7. 服务的覆盖半径由**管/缆网络**决定，不只是"挂一条路"

设施 Marker 挂到一条 net 实体后，覆盖的是**该管网可达的临街建筑**：东群污从 52%→84% 是靠**沿 22 街铺管**，
水停在 50% 是因为**一条街也铺不了**。⇒ 只放设施不铺管，覆盖约为该设施连接所及的那一半。

## 8. 服务**不是**"同分量即服务"：分量是必要不充分（2026-10-02 深夜修订）

> **修订说明（与本节旧结论冲突，依据在下）**：旧文说"覆盖不随距离衰减"。
> 那次实测的距离只有 **300–800 m**，不足以支撑"无衰减"。本轮在同一分量上测到明确的反例。

**同分量、但设施太远 ⇒ 不服务（实测）。** 小区 `(888,−535)` 280×200 m **已接入主分量**（图读回同 root），
13 栋建筑的 `consumerService` 却是 **水 13/13、电 1/13、污 0/13**。随后在 **569 m** 处放一座
`WindTurbine03` 并接 52 m 低压地缆到**本区自己的街**，跑 8 游戏小时后 **电 1/13 → 18/18**。
两台风机（新的近、旧的 1 km 外）connector 结构**完全一致**（`attached:true`、`connectedEdgeCount:1`、一条低压地缆），
差别只有距离。

**实测距离与结果**（欧氏 / 图最短路到设施所在街道）：

| 设施 | 欧氏 | 图路径 | 是否服务小区 |
|---|---|---|---|
| WindTurbine03（新，569 m 处） | 569 | 680 | **电 18/18** |
| GroundwaterPumpingStation01 | 611 / 571 | 1145 | **水 18/18** |
| WindTurbine03 | 1122 | 1265 | 电 ≈8% |
| WindTurbine03 | 1021 | 1323 | 电 ≈8% |
| SewageOutlet01 ×2 | 1028 / 1389 | 1465 / 1631 | 污 0% |

⇒ **有距离/路径上限**，但**形态未定**：欧氏界落在 (611, 1021]、图界落在 (1145, 1265] 都能解释全部行，
本轮数据**无法区分**。**不要**把其中任一条当定律。

**可执行的规则**（保守、已被证明充分）：
- 判"能不能服务"用 `serviceReachByNet`（本区街道 → 各网最近设施的欧氏/图距离 + `withinReach`），
  **不要**只用 `netsMissingService`（它只答"同不同分量"）。
- **新区 600 m 内每个网都要有设施，否则就近补放**；补放后必须让设施的地缆/管**挂到本区自己的街**上
  （上表第一行：挂在本区街上 ⇒ 18/18）。
- 600 m 是**保守充分值**（569 m 已证充分），**不是**"超过就一定不行"的判决线。

**地图约束（本区实测）**：小区 **600 m 内没有任何水体**（最近水 ~1 km），而 `SewageOutlet01` 只能临水放
⇒ 本区**无法就近补排污口**，污覆盖 0% 是**地图限制**，不是几何/分量问题。
（"排污口必须临水"由既有两座排污口的位置与 §3 推得，本轮**未重新证明** —— 对象预检通道对所有请求都答 409，未定因。）

### 8a-0. ⚠️ 读数陷阱：`sewageConnected` 在 **`consumerService.water`** 之下（2026-10-02 深夜）

**这是本轮最大的坑，也曾导致一整轮的错误结论。** 游戏只有一个 `WaterConsumer` 组件，同时携带供水与排污状态：

```
consumerService: {
  electricity: { connected, wantedConsumption, fulfilledConsumption, ... },
  water:       { waterConnected, sewageConnected, wantedConsumption, fulfilledFresh, fulfilledSewage, ... }
}
```

**没有 `consumerService.sewage` 这个键。** 读 `.sewage.sewageConnected` 永远拿到 `undefined` ⇒
**一栋完全接通的建筑会被读成"污 0%"**。本仓库的 `scripts/tmp-expansion-readback.ts` 曾如此，
于是"污 0/21"这个"blocker"完全是**测量错误**：修正后同一世界、同一建筑读作 **污 21/21**。
⇒ 判污**必须**读 `consumerService.water.sewageConnected`（以及 `.fulfilledSewage`）。

### 8a. 沿街铺管能不能把服务"拉"过来：**实测未成功**（2026-10-02 深夜）

推论：既然 §7 说"沿街铺管能抬覆盖"（东群污 52%→84%），那就从最近的排污口沿路网把 `Small Sewage Pipe`
一路铺到新区。**只读 + 实测都做了**，结果：

- 最近排污口 `(−192,230)`：marker 离路 **148.7 m**，**图距 1465 m**，沿路网需铺 **16 条街 = 1421 m 管**。
- 实铺后世界有 **47 条 `Small Sewage Pipe`**；跑 8 游戏小时复读 —— **新区污仍 0/21**（水 21/21、电 19/21）。

⇒ **端到端的"沿街铺管送服务"这条路，本轮没有走通**。成因**已定位**（见下，管网络是碎的）。
**不要**据此写"排污口必须临水"或"沿街铺管可行/不可行"的规则。

**管网络是碎的（只读拓扑，`scripts/tmp-sewage-topology.ts`）**：47 条 `Small Sewage Pipe` 组成
**37 个分量**（多数是孤立单段，最大分量 8 条）；**区内 8 条管条条独立**；
两个排污口 marker 挂接的管段（`222478` / `54532`）所在分量**与区内分量不连通**。
⇒ **铺下去的管没有把服务送到区内**，而且**污覆盖照样 21/21** —— 说明
**水/污服务是经「道路分量」给的**，与这些管无关（它们是散块，正确拓扑下应当移除，但产品无拆除原语）。
⚠️ **不要再"沿街铺管"去拉污覆盖**——本轮实测证明对密网格无效，且会留下碎片。

⚠️ 铺管时必须带重试：桥是单线程的，无重试时 40 门课只成 13 门（争用被当成拒绝）。

## 8b. 判分量的方法（保留，仍然必要）

判"是不是同一张网"仍要用分量：`netsMissingService`（union-find 在街道节点图上求分量），
或用 `scripts/tmp-component-census.ts` 全图普查。**分量是必要条件**：不同分量的设施永远不服务，无论多近。

## 9. 40 m 街区**无法靠沿街铺三网覆盖**（2026-10-02 晚实测）

`allocateUtilityStreets` 对新区 21 条街的实测：**只分得出去 8 条**（电 3 / 污 3 / 水 2），**13 条无解**、`nodeConflicts=0`。
原因：40 m 街区的节点到处共用，"每个道路节点只承载一个 net 物体"在这么密的网格里意味着三网互相排斥到无法覆盖。

⇒ 与第 8 条一致：**主体路线是"设施挂接"，不是"沿街铺管"**。第 7 条描述的"沿街铺管抬覆盖"适用于**稀疏街网**（东群），
不适用于 40 m 密网格。

## 10. 跑模拟窗口：里程碑弹窗会把游戏**暂停**（2026-10-02 实测）

`consumerService` 是活状态，必须在跑过模拟窗口后再读。但 `/sim/run?hours=&speed=` 常常**跑不动**：
`/state` 一直 `paused=true`、`frameIndex` 不前进。根因是 **CS2 的里程碑解锁弹窗**（blocking modal）——
它把游戏暂停，改速度也无效（`/sim/control` 设的 `selectedSpeed` 立刻被重置为 0）。

处理（两步，都别猜）：

1. `GET /ui/blocking-modal` → `active:true` 时拿 `modalIdentity`（`kind` / `entity.index` / `entity.version` /
   `milestoneIndex` / `isVictory`）。
2. `POST /ui/blocking-modal/dismiss`，body 为
   `{"expected":{"kind":"PROGRESSION_MILESTONE","entity":{"index":..,"version":..},"milestoneIndex":..,"isVictory":false}}`。
   **必须带 `expected`**，否则答 `STALE_MODAL_IDENTITY`（`ModalClass` 必须是 `KNOWN_SAFE_DISMISSIBLE_MODAL`）。
   返回 `status:DISMISS_CONFIRMED` 后再 `/sim/run`，`frameIndex` 才会推进。

⚠️ 弹窗会**反复出现**（每次解锁里程碑），长跑前每轮都查一次。

## 11. 桥侧已知弱点：native 操作会被"失焦暂停"永久攥住锁（2026-10-02 实测）

**现象**：`/state` 的 `world.nativeOperationBusy=true`、`world.nativeOperationStage="CreateDefinitions"`，
`frameIndex` **冻结**（实测连续 4 分钟 + 解暂停 + 跑 2 h 模拟都不前进），此后**所有写接口被拒**
（`cs2_place_building` 恒答 `another build operation is in progress`，`/build/road` 恒 409）。
桥本身健康（`/ping` 正常、`/spatial/*` 与 `/city/*` 只读全部可用）。账本不受影响。

**根因（两条叠加）**：
1. **CS2 窗口失焦会暂停游戏**，而 `CreateDefinitions` 这类 native 操作**需要帧才能完成** ⇒ 暂停即永远完不成。
2. **mod 的 `CreateDefinitions` 没有超时/回滚**：一次被拒（409）或未落定的定义创建会把锁攥住不放，
   没有 API 可以清（`/build/demolish` 需要实体）。

**触发它的错误用法（本轮亲历，不要重犯）**：
- ❌ **拿写接口探活**：为确认哪套桥在跑，GET 了一个 `/build/road?...x1=0&z1=0...` —— 那是**未拥有地面上的写操作**，被拒也可能留下半成品定义。
- ❌ **把含糊响应当成功**：`cs2_place_building` 返回状态 `"?"`（非 placed/ok/success）时继续往下发命令 ⇒ 留下一个挂着的**幽灵建筑**。
- ❌ **重试"新命令"而不是"等前一条落定"**：`another build operation is in progress` 是争用，正确反应是退避后**只读确认 `nativeOperationBusy=false`**，不是换一条几何立刻重发。

**正确做法（强制）**：
1. 任何写之前先只读确认 `world.nativeOperationBusy === false`。
2. **禁止用写接口探活**。
3. 临时脚本的写操作一律 **单条提交 → 读回落定 → 再发下一条**；响应状态含糊（`?`/缺字段）**视为未落定**，停下读回，不得继续。
4. 优先走产品自己的放置/连接路径（`executeSharedUtilityRecovery`），不要用 ad-hoc 缆。

**恢复**：玩家 **Save 后 Load 一个干净档**（最干净）；或退回主菜单再进游戏。

## 12. 判覆盖率：**分母只能是"有 consumer 组件的建筑"**（2026-10-02 实测，先犯后改）

`cs2_utility_connectors` 对一栋**没有 consumer 组件的空壳建筑**返回 `consumerService:
{electricity: null, water: null}` —— 不是"未接线"，是**根本还没有消费者**（刚划完区、还没落成的楼）。
把它当"未服务"计入分母，会把覆盖率读低一大截。

**本轮亲历的代价**：同一片岛，"分母 = 框内所有建筑"读作 **电 25/36 = 69%**（11 栋 `null` 被当成未通），
"分母 = `consumerService.electricity !== null` 的建筑"读作 **电 25/25 = 100%**。
之前几轮据此得出的"欧氏 325 m ⇒ 覆盖 0%""就近放风机 48%""铺缆后 13%"**全部是同一个测量错误的产物**，
**不是世界的事实**。

**正确读法**（两者都要）：
1. 逐栋读 `consumerService`；
2. **`electricity === null` ⇒ 该建筑不进分母**；只有非空对象才按 `connected === true` 计入；
3. 世界必须**跑过模拟窗口**再读（`consumerService` 是活状态，暂停时不刷新）。

**修正后的实测**（世界 generation `ff472a1098e24131b052079ecbea57a2`，即玩家 Load 的「斯奈德维尔 5」，**零写入**）：

| 区域 | 真实消费者 | 电 | 水 | 污 |
|---|---|---|---|---|
| 东群岛 (950,300)+(550×450) | 25（另有 11 栋空壳） | **100%** | **100%** | **100%** |
| 主城 (-450,-600)+(900×900) | 28（另有 2 栋空壳） | **100%** | 96% | 96% |

## 13. 电的投送：本地风机**不参与**投送（2026-10-02 读回）

沿用 `matchConnectionObjective` 的读口（`cs2_utility_connectors {index,version,connector:<marker节点>}` →
`topology.connector` / `topology.targetNetwork`），全城 3 台风机的读数：

| 风机 | attached | networkConnected | **targetNetworkReachable** | orphan | 自己的 edges |
|---|---|---|---|---|---|
| @5,25 | true | true | `false`（`target=null, flowNodes=[]`） | true | **0** |
| @1422,507 | true | true | `false` | true | **0** |
| @989,697 | false | true | `false` | true | **0** |

⇒ **全城没有任何一台风机接入路网**（`edges=0`、`target=null`），而岛内 25/25 栋真实消费者**仍然 100% 通电**。
⇒ **这个世界的电不由这些风机供给**（来自外部连接/主网），`attached` 与任何结果也**不相关**。
⇒ **"已有风机在 325 m 内"不能作为"这个区有电"的证据**；唯一权威是逐栋 `consumerService`（§12）。

⚠️ `DEFAULT_SERVICE_REACH_METERS = 600`（`v2/utility-service-reach.ts`）**依据已作废**（其样本来自上述错误分母）。
**暂不改动**——在手上有正确分母的重测数据之前，任何新阈值都是猜。

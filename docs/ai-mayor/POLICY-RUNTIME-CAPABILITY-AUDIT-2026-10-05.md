# POLICY → RUNTIME → CAPABILITY CLOSURE AUDIT（2026-10-05）

只审计，不修改行为。权威：`docs/FAST_EXPANSION_V2 Gameplay Policy Candidate.md`（下称 V2）。

## 0. 方法与证据口径

- **"文件里有代码"不算实现。** 每项追链：Policy predicate → 生产 runtime 调用 → planner/action → world primitive → authoritative readback。
- **LIVE 证据来源**：今天（2026-10-05）7 个决策日志 `tmp/decisions-2026-10-05*.jsonl`（共 19 个历史日志）的出现次数，加 4–5 号各会话已记录的 live 事实（交接文档、记忆）。次数是 grep 计数，不是效果证明。
- **关键背景**：live 跑过的最大城市约 8.2–9k 人（2026-10-04）；今天最长一轮到 ~1,000 人。**S2–S4（M4 以后、30k–100k）从未 live 跑到。** 所以"live proven"只覆盖 S0–S1 附近。
- 标签：`WIRED_AND_LIVE_PROVEN` / `WIRED_NOT_LIVE_PROVEN` / `PARTIAL` / `NOT_WIRED` / `BLOCKED_BY_MISSING_PRIMITIVE`。

## 1. P1–P9 逐项

| # | 机制 | 标签 | 追链与证据 |
|---|---|---|---|
| P1 | 阶段机（里程碑切换） | **WIRED_AND_LIVE_PROVEN**（S0–S2 范围） | `growthStage`（growth-policy.ts）← `#planGrowth` ← `readProgress`（`cs2_city_overview.milestoneLevel/xp/nextMilestoneXp`）；日志里 `stage S0..S2` 133 行，milestone 读数真实（"979 XP to the next milestone"）。S3/S4 从未到达。 |
| P1 | **主动 XP rush** | **NOT_WIRED**（读口有，动作无）+ XP 单动作价值 **BLOCKED_BY_MISSING_PRIMITIVE** | `xpGap` 只写进 notes（district-builder.ts:2103），没有任何分支据此放服务/Signature/升级。服务建筑只在"出现 Hearse/Ambulance 图标"时放（`provideServices`），不是 XP 动作。HANDOFF-2026-10-03 第 258 行明写"P1 里程碑冲刺的 XP 行动（缺 Bridge C# 读口）未做"。`cs2_upgrade_road` 不是道路升级（记忆）。 |
| P2 | 动态 batch = min(资本,吸收) | **WIRED_AND_LIVE_PROVEN** | `batchConstraint`/`absorbableCells`/`capitalAreaCap` ← `#planGrowth`/`#withBatch` ← `maximumAreaSquareMeters` ← 区块器；日志 `capital-bound` 116 行、`absorption-bound` 1 行、`seed-bound` 开局。**弱点**：人口 <100 吸收上限不可读，靠种子批；吸收只对住宅；没有实测 spawn 上限（E2）。"大批次一次性下发"：`districts 2 of the same batch` 已有。 |
| P2 | 记录哪个上限在约束 | WIRED_AND_LIVE_PROVEN | `Constraint.binding` 写入 `batch:` 笔记与结果。 |
| P3 | 阶段密度切换（最高已解锁，低密配额） | **WIRED_AND_LIVE_PROVEN** | `chooseResidentialDensity` ← `#planGrowth`；日志 `density: medium/high …` 168 行（含 vacancy 排除、低密配额在 S3 之前未触发）。 |
| P3 | **划区后 N 天未开发撤回 zoning**（EmptyZones） | **NOT_WIRED** | 没有"撤回"原语调用。仅有 `rezoning`：空置住宅格改划商业/办公（`#rezoneEmptyHomes`，日志 1 行），那是改类别，不是撤回，也没有 ⟨N 天⟩ 计时。E10 未做。 |
| P3 | 只对未开发地块升密 | PARTIAL | 区块器只在新区块划区；对已有未开发格的升密路径只有上述 rezone。 |
| P4 | 岗位≥求职者、不追零失业 | **WIRED_AND_LIVE_PROVEN**（小城） | `classifyBottleneck`（growth-bottleneck.ts）← `readLabor`（`cs2_labor`）；日志 JOBS/HOUSING 两类瓶颈、"劳动力读数自相矛盾"保护。人口 <100 时读数不可用（"too few for a labour reading"）。 |
| P4 | 商业扩张以店铺库存为前提 | **PARTIAL** | 代码自己写 `commercial fallback: shop inventory not read (P4 precondition unverified)`（district-builder.ts）；没有库存读口。 |
| P4 | Office demand 不作信号 / 税率只作岗位侧杠杆 | PARTIAL | office 角色在 `chooseGrowthRole` 里；`cs2_set_tax` 只被 finance-recovery 用，没有"降工业/办公税换岗位"这条。 |
| P5 | 买地：按交付提前量 | **WIRED_NOT_LIVE_PROVEN**（今天刚改） | 新增滚动买地 `#buyLandAhead`（可达免费地 <120 ha + 12 个月赤字 runway + 一次一块）；今天日志里 `tile … bought` 3 行是旧路径。游戏在里程碑前拒卖（live 观测到）。 |
| P5 | 每次买地计 tile upkeep 追溯增量 | **PARTIAL** | `landPurchaseRunwayAffordable` 用 `observedMarginalUpkeep`（上一次购买后实测）；首次购买用预算读数的估值。E9（9/15/20/25 块曲线）未测。 |
| P5 | "真实可兑现土地容量"（planner 证据，不用原始面积） | **PARTIAL** | `decideGrowthAfterSearch` 吃 `searchComplete/rejectedSites`，但调用处 `deliveredAreaSquareMeters: 0` 为定值；"阶段 S3 飞地"优先无实现。 |
| P5 | ①外部连接/战略通道买水地块 | **NOT_WIRED** | 买地只有"空地不足/runway"两条理由，无"外连需要"理由。 |
| P6 | 瓶颈诊断四步命中即停 | **PARTIAL** | `classifyBottleneck` 只覆盖岗位/住房/商业；"需求/通道/供给"里的通道分支没有。 |
| P6 | **外部连接利用率** | **BLOCKED_BY_MISSING_PRIMITIVE** | `cs2_spatial scan` 返回 `outsideConnections`（位置），只被用来认"主路网分量"（district-builder / site-selection 等 6 个文件）；没有每条连接的利用率/迁入读口。 |
| P6 | **新增道路外连** | **NOT_WIRED** | 无"在地图边缘新建外部连接"的 planner。原语（`cs2_build_road` 到边缘）可能够，未验证。 |
| P6 | **铁路外连** | **BLOCKED_BY_MISSING_PRIMITIVE（未验证）** | HANDOFF 写明"P6 铁路/外部连接原语未做"；MCP 工具表里没有铁路/车站专用工具，`cs2_find_prefabs`/`cs2_build_road` 能否铺轨未验证。文档里也没有"火车爆发人口"的描述：只有 E1"铁路是否比道路迁入更快尚无证据"。 |
| P7 | 容量余量 ≥1.2–1.3×峰值 | **WIRED_AND_LIVE_PROVEN** | `UTILITY_HEADROOM_FACTOR=1.25` ← `#provideUtilities`；日志 `fits the headroom` 39 行；设施放置后读回 `attached`/容量（`CAPACITY_READBACK`）。 |
| P7 | 电源枚举全部已解锁类型并按成本排序 | **PARTIAL** | `rankPowerSources` 枚举全部发电类型，按"产出/建造成本"排序；**不含月维护费与出口收益**（Bridge 不报，E6）。live 实际选出的几乎全是风机。 |
| P7 | 完整设施候选（水/污水） | **PARTIAL** | 水：泵/水塔枚举 live 通过；污水：今天 2 张图都"没有路边靠水地块"→放不下（`NO_OPEN_WATER_NEAR_LOT`），**没有沿岸候选/长管**（已记缺陷）。 |
| P7 | 远距离输电/输水路径容量 | **NOT_WIRED** | 只用"贴街 + 补一段管线"，不检查路径容量。 |
| P7 | 三档通知分类 | **WIRED_AND_LIVE_PROVEN**（分类）/ PARTIAL（应答） | `triageNotifications` ← `provideServices`；日志 `deferred` 14 行。立即档里：缺电/水/污水、无路、Hearse/Ambulance 有本地答案；垃圾、火灾、倒塌、废弃等记为 capability gap（未答）。 |
| P7 | 拥堵：Traffic infoview 梯度读回、改路口形态 | **NOT_WIRED** | 日志每个周期都写 `congestion icons … (no traffic reading: not acted on)`（404 行）。读口（`cs2_gridmap` 是否含交通）未验证。 |
| P8 | 现金储备 + 月盈余连续为负则冻结 | **WIRED_NOT_LIVE_PROVEN** | `FinanceWatch`（K=3）← `#planGrowth`；单测有，从未在 live 触发。 |
| P8 | 贷款三档（<30% / 30–70% / >70%） | **WIRED_AND_LIVE_PROVEN**（早期会话） | `loan-policy.ts` ← `#loanStep` ← `cs2_get_loan/cs2_set_loan`；旧日志有 31 处贷款笔记（今天会话 0 次，因现金充足）。利率读回按日息。 |
| P8 | 水电收费滑块 | PARTIAL | `cs2_set_fee`/`cs2_get_fees` 存在，仅 finance-recovery 用；P8 的"财政紧张上调/宽松下调"没有策略分支。 |
| P9 | 版本绑定 | **PARTIAL**（仅标签） | `POLICY_GAME_VERSION="1.6.2f1"` 写进每条 growth 笔记；**没有**"版本变化→相关规则自动进入待复核"的比较逻辑。 |

## 2. 额外发现（V2 之外，但影响 0→100K）

| 项 | 标签 | 说明 |
|---|---|---|
| 跨水桥 | **WIRED_NOT_LIVE_PROVEN**（且达不到用户要求） | 今天新增 `water-crossing.ts`：每周期最多建 1 座，按"最短水跨度"排序，只在可达免费地 <120 ha 时触发。用户反馈：要像路网一样一次修 3–5 座，且不能只挑最偏的一条小路。游戏确实接受直接铺路过河（实测），但接口读不到"是不是桥"；用户亲测带"桥"字的预设和普通路一样。 |
| 区块先铺路再划区（路网先行） | WIRED_AND_LIVE_PROVEN | 用户明确要求保留。今天加的"未填满库存"闸门把"铺路+划区"一起挡了，已改为只挡住宅区；"路网铺满、划区分批"还没做。 |
| 工业与住宅隔离 | WIRED_AND_LIVE_PROVEN → 今天修了点取样缺陷 | 长条住宅区只用四角+中心判隔离；已改为整块取点（未 live 验证）。 |

## 3. LIVE_FALSIFICATION_QUEUE E1–E10

| # | 状态 | 依据 |
|---|---|---|
| E1 外部通道/铁路 vs 道路 | **研究假设**（未做） | 没有 30k 存档点；没有铁路原语。 |
| E2 Spawn 上限 | **研究假设**（未做） | 无 5k/20k/50k/80k 点；城市从未超过 ~9k。 |
| E3 Signature/服务 XP 价值、16 vs 32 次/天 | **研究假设**（BLOCKED：缺单动作 XP 读口） | 只能读总 XP。 |
| E4 密度偏好拒住 | **研究假设**（未做） | 未做"只提供 HD 住房"对照。 |
| E5 尾段岗位杠杆 | **研究假设**（未做） | 从未到 ~80k。 |
| E6 电源经济性 | **部分已测** | 风机实际出力/名义（`windCapacityFactor`）已读回；**月维护费、出口单价**无读口。 |
| E7 交通负载 vs 模拟速度 | **研究假设**（未做） | 测过的只是 Bridge 读放大（不是交通）。 |
| E8 飞地 vs 原地升密 | **研究假设**（未做） | 无对照。 |
| E9 Tile upkeep 曲线 | **部分已测** | 2026-10-04 事故：6 块地使 tile upkeep 0→99k/月；HANDOFF 记每块约 3.3k/月；9/15/20/25 块读回未做。 |
| E10 EmptyZones 抑制强度 | **研究假设**（未做）；但有旁证 | 5 号一轮 live：2 万格划区 + 人口 700–1000 时 residential/commercial 需求为 0（EmptyBuildings 抑制）；划 100 格对照未做。 |

## 4. 缺口表（按对"0→100K ≤120 min"的预期影响排序）

> 影响排序是**判断**，不是测量：除 5 号一轮外没有 30k 以上的 live 数据，越往后的项越不确定。

| 排名 | 缺口 | 类型 | 预期影响 | 理由 |
|---|---|---|---|---|
| 1 | **S2–S4（30k–100k）从未 live 跑到**：EmptyBuilding 抑制、吸收上限、外连、交通、电力全是未知 | 证据缺口 | 极高 | 120 分钟目标的主要时间在 30k 之后；现在所有结论只覆盖 ≤9k。 |
| 2 | **P1 主动 XP rush 未接**（NOT_WIRED；单动作 XP 读口缺） | 缺 planner + 缺原语 | 高 | 里程碑决定解锁、买地配额和高密；今天"0 里程碑拒卖地"就是它卡的。 |
| 3 | **P6 外部连接**：新增道路外连（NOT_WIRED）、利用率读口与铁路外连（BLOCKED） | 缺 planner + 缺原语 | 高（30k–100k） | V2 把它列为 S4 核心；E1 未做，不知道是否绑定。 |
| 4 | **土地容量与通行**：滚动买地 WIRED_NOT_LIVE；跨水桥只有单座、选址不当、无法验证是桥；买地缺"外连需要"理由；无"真实可兑现容量"交付量 | PARTIAL | 高 | 用户明确要求；地图被水切开时直接决定可建面积与工业隔离。 |
| 5 | **P3 撤回未开发 zoning**（NOT_WIRED）+ 路网先行后"划区分批放"（未做） | 缺 planner | 中高 | 大批量空划区会触发 EmptyBuildings/EmptyZones 抑制，是"房子长不出来"的结构原因之一（E10 未测）。 |
| 6 | **P7 拥堵**（NOT_WIRED，读口未验证） | 缺读口 + 缺 planner | 中（10k 以后）| V2 明确要求用 Traffic infoview；现在每周期都写"不处理"。 |
| 7 | **污水沿岸选址**（没有长管/沿岸候选） | PARTIAL | 中 | 两张图都放不下污水；影响居民满意度与迁入，但不一定阻塞增长（今天 1000 人期未见阻塞）。 |
| 8 | **P4 商业库存前提**（缺库存读口） | PARTIAL | 中 | 商业补岗位路径有"前提未验证"的 fallback；供应链问题会被当成缺商业。 |
| 9 | **P7 电源经济性与远距离输电**（缺月维护费/出口读口；路径容量未查） | PARTIAL / BLOCKED | 中（扩张到边缘时）| 全风机、按建造成本排序；远距离时输电容量可能先爆。 |
| 10 | **P8 冻结/收费滑块 live 未触发** | WIRED_NOT_LIVE | 中低 | 前期现金充足；一旦 30k 后现金流转负才暴露。 |
| 11 | **P9 版本绑定仅标签** | PARTIAL | 低 | 对速度无影响，对结论可信度有。 |
| 12 | **P5 tile upkeep 曲线（E9）**、**E2/E4/E5/E7/E8 实验** | 研究假设 | 低到中 | 决定批量/配额校准值，当前全部是占位值 ⟨待标定⟩。 |

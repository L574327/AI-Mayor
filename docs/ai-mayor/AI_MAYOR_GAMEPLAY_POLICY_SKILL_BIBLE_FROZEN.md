# AI MAYOR GAMEPLAY POLICY & SKILL BIBLE — FROZEN

**Freeze date:** 2026-09-30  
**Status:** `FROZEN`  
**Authority:** Gameplay-policy asset only. This document defines **how a high-level, long-running autonomous Cities: Skylines II Mayor should play**. It does **not** define TypeScript/C# architecture, Brain internals, Gate1, durability, execution-kernel implementation, or current code completeness.

---

## 1. Scope / authority / version assumptions

### 1.1 Source authority

1. **Primary authority:** the original Astra research package, including its expert knowledge map, rule cards, K01–K12 skill specifications, Part E raw knowledge pack, expert disagreements, and the 66 Knowledge Cards.
2. **Secondary authority:** the later Skill Manifest, used as a structural index and cross-check only.
3. **Current product evidence supplied for this freeze:** later live engineering evidence may invalidate old *implementation-status* claims, but does not erase gameplay knowledge. In particular, old `UNKNOWN/MISSING` implementation labels are **not** used here to downgrade a gameplay rule.
4. **Conflict rule:** if the Manifest and original research disagree, the original research wins unless a later real-game proof or current-version official mechanic clearly supersedes it.

### 1.2 What is frozen

Frozen:
- gameplay doctrine;
- city phase model;
- Planning Methods and their ownership boundaries;
- executable Skill semantics;
- domain policies;
- Knowledge Card dispositions;
- old-asset → final-asset migration.

Not frozen:
- exact numeric thresholds that depend on game build, DLC, asset packs, map, difficulty or measured distributions;
- code/API mappings;
- telemetry endpoint design;
- execution-kernel implementation;
- post-freeze changes required by a future game patch or by long-run evidence that falsifies a rule.

### 1.3 Policy-strength vocabulary

| Strength | Meaning |
|---|---|
| `HARD_INVARIANT` | Must not be violated by normal autonomous play. Usually protects correctness, causality, safety, or an observed game-mechanic distinction. |
| `STRONG_POLICY` | Default high-skill behavior. Override only with explicit evidence that the local context justifies it. |
| `HEURISTIC` | Useful expert strategy; map/build/asset/context dependent. Never treat as game law. |
| `DIAGNOSTIC_HINT` | A clue that narrows investigation. It never authorizes construction by itself. |

### 1.4 Version baseline and targeted 2026 verification

This freeze uses a **2026-09-30 baseline**. It does not assume a specific build number when the exact current executable build has not been read from the running game. Only version-sensitive claims that could materially change policy were spot-checked.

- Economy 2.0's removal of government subsidies, service-import fees and higher service costs remains part of the official mechanic background; Tile Upkeep remains an explicit land-cost mechanic. citeturn172947search2turn172947search1
- Patch 1.5.4f1 changed bicycle trip frequency substantially, so bicycle-share expectations and any historic bike-volume heuristic are not frozen as constants. citeturn204079search4
- Patch 1.5.7f1 changed education balance and stopped citizens moving in/out by taxi, so old education-demand ratios and taxi-heavy move-in-wave signatures are not frozen. citeturn204079search5
- 1.5.9f1 / Morning Dew explicitly focused on vehicle behavior and pathfinding, so traffic-routing heuristics must remain observational instead of assuming old pathfinding behavior. citeturn204079search3
- Autumn Breeze changed garbage-truck logic, reinforcing that service-chain policy is stable while exact failure signatures are version-sensitive. citeturn204079search2
- The September 15, 2026 release introduced a new expansion wave and an Autumn Breeze patch; tourism/visitor-specialist policy is therefore **not** inferred from older material and remains a missing asset until deliberately researched. citeturn204079search12

### 1.5 Freeze rule for future versions

On a future game version:
- keep `HARD_INVARIANT` rules unless direct evidence falsifies the underlying distinction;
- revalidate all `VERSION_SENSITIVE_*` assumptions before using them as predicates;
- never auto-promote patch notes, community anecdotes, or a single successful run into a new hard rule;
- a changed numeric optimum updates parameters, not this Bible's decision hierarchy, unless the mechanic itself changed.

---

## 2. Core gameplay doctrine

The final Mayor doctrine is deliberately small:

1. **Build only to relieve a diagnosed constraint.** Demand, alerts, population and UI colors are signals, not orders.
2. **Deliver complete, bounded tranches.** Road → usable frontage/parcel → zoning/facility → local utility/service fulfillment → absorption/operation evidence is one causal unit.
3. **Observe local fulfillment, not citywide totals.** Capacity without connectivity, access, staffing, vehicles or actual delivery is not success.
4. **Separate inventory from absorption.** Zoned-but-undeveloped, built-but-vacant, and occupied/operating capacity are different states.
5. **Prefer the smallest complete intervention.** One major causal change, then bounded observation, beats simultaneous speculative construction.
6. **Preserve future options.** Reserve corridors, service sites and buffers before they are needed; reservation is not permission to spend immediately.
7. **Treat finance as runway through the effect window.** A temporary deficit can be rational; an unaffordable incomplete growth loop is not.
8. **Use functional networks, not geometry dogma.** Roads, transit, utilities and freight are accepted only when the game can actually use them for their intended purpose.
9. **Diagnose before duplicating capacity.** Existing facilities/networks that do not fulfill their role are investigated before a second copy is built.
10. **Use state-based city phases.** Medium/large-city behavior begins when cross-district dependencies, capacity distribution, congestion, labor structure and renewal become material—not at a magic population number.
11. **Bound all waiting, retries and replans.** Activity without state progress is not progress.
12. **Stop safely on uncertainty.** `UNKNOWN` is never `PASS`; insufficient evidence is a legitimate reason to pause, re-observe, shrink, re-site or hand off.

### 2.1 Frozen anti-regression invariants from real product experience

These are mandatory policy-level protections:

- `demand != build order`
- `global utility capacity != local service delivery`
- `building exists != service fulfilled`
- `Road created != Road Access successful`
- `geometry intersects != native connectivity`
- `zoning cells changed color != viable building/parcel delivered`
- never demolish/rebuild whole roads indefinitely to recover a few zoning cells
- never place services from population thresholds alone
- never treat a short-lived move-in surge as proof that permanent traffic reconstruction is needed
- `UNKNOWN != PASS`
- every wait has an absolute bound
- never build several same-purpose facilities before the previous one is proven to operate
- recovery cannot erase history by changing project/task identifiers
- an unimplemented/un-green Skill name is not itself a reason to start construction

---

## 3. City phase model

Phases are defined by the city's control problem, not by a population threshold.

### 3.1 EARLY — Deliver the first repeatable growth loop

**Mayor problem:** scarce cash, few alternatives, low redundancy, high sensitivity to a single bad site or unfinished dependency.

Observe:
- complete site cost and access;
- actual buildable parcels;
- local electricity/water/sewage;
- cash runway;
- small R/C/I/O inventories and absorption;
- first essential-service deficits;
- whether new residents/buildings actually become occupied/operational.

Do:
- run one active capital-development tranche at a time by default;
- keep road/utility/service scope minimal but complete;
- release zoning in small capacity batches;
- reserve future corridors/sites without building them prematurely;
- let evidence decide wait / next tranche / diagnose / stop.

Do not:
- overbuild services “for later”;
- open remote districts because land is cheap;
- chase every demand bar;
- create complex transit or road hierarchies without a current need;
- use debt to sustain an incomplete permanently loss-making structure.

**Exit EARLY when:** multiple tranches have been absorbed reliably, basic utility/service delivery is repeatable, the city has a stable runway, and the limiting questions begin to be structural distribution rather than first-delivery survival.

### 3.2 MID — Coordinate multiple districts and interacting capacities

**Mayor problem:** citywide totals stop explaining local outcomes. Labor, services, traffic, freight, utilities and district growth interfere with each other.

Observe:
- housing/jobs/education by structure;
- district-level service fulfillment and utility distribution;
- persistent traffic and critical routes;
- parking/walking/cycling/transit alternatives;
- freight and industrial supply-chain behavior;
- whether outward expansion is better than infill/densification.

Do:
- compare densification, old-district completion and a second district as competing solutions;
- establish transit only where a corridor-level need exists;
- repair persistent bottlenecks one cause at a time;
- add service/utility capacity from actual deficits;
- begin intentional freight/logistics management;
- use multiple districts without letting them independently over-commit the same money/capacity.

Do not:
- use population milestones as automatic metro/service triggers;
- assume a green citywide capacity means every district is healthy;
- use a new district to hide poor absorption in the old one.

**Exit MID when:** cross-district networks, redundancy, multimodal corridors, renewal and worst-district quality dominate marginal greenfield growth decisions.

### 3.3 LARGE — Operate a resilient multi-district system

**Mayor problem:** long-run stability, network resilience, renewal, distributional bottlenecks and compounded failures matter more than raw expansion.

Observe:
- worst stressed district and critical service chains, not just averages;
- redundant electricity/access/freight/transit dependencies;
- large-corridor capacity and failure propagation;
- aging/obsolete district layout and replacement needs;
- long-horizon education, logistics and fiscal commitments.

Do:
- renew/densify with replacement-before-removal;
- maintain alternate routes and critical-chain redundancy;
- use multimodal passenger and freight corridors;
- phase large works so city function survives construction;
- preserve causal attribution by limiting simultaneous unverified changes.

Do not:
- equate “still growing” with “stable”;
- optimize only citywide averages;
- tear out functioning capacity before its replacement is live.

### 3.4 OPTIONAL SPECIALIST contexts

Some maps or player goals require specialist behavior earlier than the normal phase:
- mountain/river crossing;
- advanced terrain megaprojects;
- disaster response;
- tourism/landmark specialization;
- aesthetic/role-play optimization.

Only `BuildTerrainCrossing` is sufficiently supported by the frozen source to become an executable specialist Skill. The others are handled in Section 8 as missing or non-gameplay assets.

---

## 4. Planning Methods

Planning Methods generate plans. They **do not** independently decide to spend money or call game actions.

### plan.P1 — Map decomposition

- **method_id:** `plan.P1`
- **purpose:** 把地图拆成可开发连续区域、保护区、障碍、外部连接、候选跨越点与未来扩展方向；只生成空间事实与候选区域，不决定自主施工。
- **inputs:** 地形/水体/已购地/外部连接/现有网络/污染与资源（若可观测）/保护与保留约束。
- **outputs:** region/block/corridor 候选、不可开发/受限区域、候选入口、失效条件。
- **constraints:** 不得把“最近道路”当默认起点；未知污染/水流等安全事实不得猜测；保留地不等于立即开发。
- **scoring criteria:** 到可入住/可运营的完整交付成本、连续可用面积、接入与 utility 成本、坡地/污染风险、后续扩张余地。
- **stop conditions:** 得到少量可比较区域；或关键安全/能力事实不足而明确 BLOCKED。
- **owner skills:** SurveyDevelopmentSite、BuildTerrainCrossing、阶段/扩区政策
- **knowledge rules:** K01–K05、K09、K39–K40、K63

### plan.P2 — Strategic region allocation

- **method_id:** `plan.P2`
- **purpose:** 为住宅、就业、污染产业、服务、utility、货运、交通走廊和保护空间分配区域角色。
- **inputs:** P1 区域、城市阶段、住房/岗位/服务/utility 库存与约束、玩家意图。
- **outputs:** 区域角色与保护/预留约束；不是施工命令。
- **constraints:** 污染隔离与通勤/物流联合优化；不得把全部空地视为待填充；不得按人口阈值机械升级城市形态。
- **scoring criteria:** 功能兼容、服务与物流成本、跨区依赖、冗余、长期扩展与改建成本。
- **stop conditions:** 角色冲突已消解且能被分期项目消费；或关键资料不足。
- **owner skills:** SurveyDevelopmentSite、BalanceHousingJobsEducation、ManageFreightIndustrialLogistics、阶段政策
- **knowledge rules:** K05、K09–K10、K17、K25、K27、K61、K63

### plan.P3 — District layout compilation

- **method_id:** `plan.P3`
- **purpose:** 把一个已批准区域编译为道路、街块、设施预留、utility 走廊、步行/公交连接和分期边界。
- **inputs:** 区域角色、地形、入口、资产尺寸、道路/服务/utility 约束。
- **outputs:** DistrictPlan：街块/道路角色/设施预留/保护区/分期边界。
- **constraints:** 规划方法无独立建设权；不能为了几何整齐覆盖保护/服务预留。
- **scoring criteria:** 有效 frontage、可建地块、连通冗余、道路/设施成本、未来改建弹性。
- **stop conditions:** 形成可被 P6 分期的布局，或 native/资产适配证据不足。
- **owner skills:** EstablishDistrictAccess、DeliverProductiveFrontage、RenewOrDensifyDistrict
- **knowledge rules:** K06–K10、K15

### plan.P4 — Road corridor planning

- **method_id:** `plan.P4`
- **purpose:** 为新区连接、骨干/沿街/货运/服务道路或跨越选择有限走廊。
- **inputs:** 起终节点、道路角色、地形、既有路网、保护/预留、交通事实（若有）。
- **outputs:** ≤3 个有用途、有影响区和验收目标的走廊方案。
- **constraints:** 道路必须有用途；几何相交不是 connectivity；不强制严格树状层级。
- **scoring criteria:** 真实可达、替代路径、frontage 收益、路口风险、坡度/跨越成本、对既有地块影响。
- **stop conditions:** 选出可 preflight 的少量方案，或无合法/经济走廊。
- **owner skills:** EstablishDistrictAccess、DeliverProductiveFrontage、RepairTrafficBottleneck、BuildTerrainCrossing
- **knowledge rules:** K02–K06、K10–K15

### plan.P5 — Block/parcel template fitting

- **method_id:** `plan.P5`
- **purpose:** 把真实 zone grid、道路参考系、坡地和资产宽深转为可开发街块/parcel 方案。
- **inputs:** native zone cells、道路几何、地形/坡度、当前资产目录、设施/走廊预留。
- **outputs:** 可用 parcel 组合、碎片格、留白/预留分类和 frontage 目标。
- **constraints:** zoning cells≠适配建筑地块；禁止为补单格无限拆路；模板尺寸不是全局常量。
- **scoring criteria:** 实际有效地块、道路面积/成本、资产适配、坡地可建深度、留白价值。
- **stop conditions:** 达到本期所需的有效 parcel 容量；或有限模板/局部调整耗尽。
- **owner skills:** SurveyDevelopmentSite、DeliverProductiveFrontage、ReleaseZoningTranche
- **knowledge rules:** K03、K07–K09、K18–K20

### plan.P6 — Project phasing

- **method_id:** `plan.P6`
- **purpose:** 把区域方案切成可交付、可观察、可中止的有限 tranche。
- **inputs:** DistrictPlan、需求诊断、库存、utility/service/finance 余量、依赖。
- **outputs:** 分期顺序、WIP 上限、每期成功/等待/失败条件与释放条件。
- **constraints:** 需求不是 build order；同类未验证设施/供给不得连续叠加；等待必须 bounded。
- **scoring criteria:** 最小完整交付、吸收速度、现金跑道、依赖闭合、失败影响半径。
- **stop conditions:** 每期能在建设→履约→吸收后明确继续/等待/停止。
- **owner skills:** ReleaseZoningTranche、ObserveDevelopmentAbsorption、ProvisionEssentialServices、RenewOrDensifyDistrict
- **knowledge rules:** K06、K18、K20、K30、K63–K64

### plan.P7 — Budget and capacity forecasting

- **method_id:** `plan.P7`
- **purpose:** 为项目估计资本支出、持续费用、服务/utility 容量、现金跑道和已承诺负载。
- **inputs:** 财库、收支、资产/连接成本、服务/utility 使用量、已承诺项目、保守收入场景。
- **outputs:** 准入/缩小/延后建议、容量 margin、应急储备需求。
- **constraints:** 菜单 upkeep 不是完整成本；固定全年 reserve% 不作为机制事实；负月结不自动等于停止一切建设。
- **scoring criteria:** 到效果显现前的生存概率、最坏可承受支出、不可逆成本、容量瓶颈。
- **stop conditions:** 能证明项目在保守情景下有跑道；否则拒绝/缩小或标 UNKNOWN。
- **owner skills:** StabilizeFinance、CommissionUtilities、ProvisionEssentialServices、Acquire-land policy
- **knowledge rules:** K29–K34、K38

### plan.P8 — Feasibility comparison

- **method_id:** `plan.P8`
- **purpose:** 比较少量完整方案，而非对单个局部动作贪心排序。
- **inputs:** P1–P7 输出、native preflight/观测、玩家约束。
- **outputs:** 可解释的方案选择、备选与拒绝原因。
- **constraints:** 比较完整交付成本与结果，不用 action count/局部便宜替代项目价值；UNKNOWN 不得伪装可行。
- **scoring criteria:** 目标满足、成本/风险、可验证性、恢复成本、长期可扩展性。
- **stop conditions:** 有一项方案满足硬约束并明显优于不可行方案；若证据不足则停止在 UNKNOWN。
- **owner skills:** 所有需要方案生成的 executable Skill
- **knowledge rules:** K01、K04、K13、K30、K33、K60、K63

## 5. Executable Skills

### 5.1 Final Skill set

The final set contains **17 executable Skills**. The original K01–K12 are retained conceptually, but renumbered into the final namespace `skill.S01`–`skill.S12`. Five additional Skills are promoted only where the raw Knowledge Cards and expert processes provide enough substance to define a non-fictional executable gameplay contract.

No Skill is created merely to make the count look complete.

### 5.2 Old K01–K12 → final mapping

| Old skill | Final asset | Freeze decision |
|---|---|---|
| K01 SurveyDevelopmentSite | `skill.S01 SurveyDevelopmentSite` | RETAIN |
| K02 EstablishDistrictAccess | `skill.S02 EstablishDistrictAccess` | RETAIN |
| K03 DeliverProductiveFrontage | `skill.S03 DeliverProductiveFrontage` | RETAIN |
| K04 ReleaseZoningTranche | `skill.S04 ReleaseZoningTranche` | RETAIN |
| K05 CommissionUtilities | `skill.S05 CommissionUtilities` | RETAIN; old implementation-status claims are ignored |
| K06 StabilizeFinance | `skill.S06 StabilizeFinance` | RETAIN |
| K07 DiagnoseGrowthBlockage | `skill.S07 DiagnoseGrowthBlockage` | RETAIN |
| K08 ObserveDevelopmentAbsorption | `skill.S08 ObserveDevelopmentAbsorption` | RETAIN |
| K09 ProvisionEssentialServices | `skill.S09 ProvisionEssentialServices` | RETAIN |
| K10 BalanceHousingJobsEducation | `skill.S10 BalanceHousingJobsEducation` | RETAIN |
| K11 RepairTrafficBottleneck | `skill.S11 RepairTrafficBottleneck` | RETAIN |
| K12 RecoverDevelopmentProject | `skill.S12 RecoverDevelopmentProject` | RETAIN |

### 5.3 Final Skill specifications
### skill.S01 — SurveyDevelopmentSite

- **skill_id:** `skill.S01`
- **skill_name:** SurveyDevelopmentSite
- **purpose:** 把“有空地/想扩区”转成可追溯的开发 site 证书，证明该区域能以合理完整成本进入可入住/可运营状态。
- **applicable_city_phase:** EARLY / MID / LARGE；开局、当前区吸收完成、现区不可行或确有新约束时。
- **trigger:** 首次选址；旧区无法提供所需住房/岗位/资源/连接；现 site 经有界失败被淘汰。
- **required_observation:** 地形、水体、已购/可购土地、现有道路与外连、候选 utility/service 接入、污染/水源安全（相关时）、可用资产与解锁、既有库存。
- **observation_quality_requirement:** 安全相关事实必须 native/authoritative 或已认证 recipe；连续面积/坡度可 derived 但需标误差；未知水流/污染不可猜。
- **decision_predicates:** 比较至少近端小分期与远端大区完整启动成本；旧区仍有可替代库存时，新 site 必须说明额外价值；买得起土地但交付不起基础服务/接入的 site 不可过。
- **priority / arbitration guidance:** 先复用已购、已接入、低风险区域；战略约束/资源/地形可证明新 site 更优时再扩。
- **allowed_actions:** 只读 survey、候选区域比较、有限 native preflight、请求购地/跨越/utility 依赖；不直接以“发现空地”为由施工。
- **forbidden_actions:** 按最近 road source 扩张；把平坦面积当唯一指标；未知污染/水流下建设高风险取排水；为便宜 tile 无理由远跳。
- **bounded_action_budget:** ≤5 个粗筛区域；每区≤3 个布局/接入方向；精细检查只给入围方案。
- **success_condition:** 至少一个区域具备可追溯的接入、地块、基础服务/utility、资金和安全证据。
- **wait_condition:** 仅等待会改变可行性的明确事实（解锁/资金/污染消散/依赖项目）；有最大窗口。
- **diagnostic_handoff:** 缺资产/解锁→MISSING_SPEC/能力；污染/水源→Utility/Pollution；旧区库存矛盾→DiagnoseGrowthBlockage。
- **failure_condition:** 所有允许 site 经有限比较仍不可行，或关键安全事实无法验证。
- **recovery_handoff:** 缩小 tranche、换已认证 recipe、请求购地/跨越、换 site；失败历史继承。
- **dependencies:** P1/P2/P3/P5/P7/P8；Finance admission；capability/version profile。
- **conflicts:** 保护区、utility 水源、污染产业、未来交通/设施预留。
- **owned_planning_methods:** P1,P2,P3,P5,P7,P8
- **owned_knowledge_rules:** K01–K09,K34,K39–K41,K63
- **hard_invariants:** UNKNOWN≠PASS；site 必须按完整交付而非裸土地可用性验收。
- **heuristics:** 山地先找台地；临水用途分别验证；留白可有价值。
- **version_sensitive_assumptions:** tile upkeep、资产尺寸、污染/水源与解锁均 version/DLC-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S02 — EstablishDistrictAccess

- **skill_id:** `skill.S02`
- **skill_name:** EstablishDistrictAccess
- **purpose:** 交付新区或关键设施的功能性道路接入，而不是仅生成一段道路。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 已批准项目缺少有效道路/服务/货运接入；现有唯一接入被证明不可靠。
- **required_observation:** 道路几何、native connectivity/reachability、目标入口、地形、交叉口、道路角色、影响区；中后期加交通流/队列。
- **observation_quality_requirement:** Road created、几何相交均不足；至少要有 native connectivity/目标 reachability 的 authoritative 证明。
- **decision_predicates:** 入口必须连到指定网络；高重要片区避免单一 collector 依赖；连接若会吸引外连—外连捷径需评估；桥隧只有在普通走廊不可行/收益合理时进入。
- **priority / arbitration guidance:** 最小能满足项目角色的连接优先；冗余按故障/交通价值增加，不为“层级美观”加路。
- **allowed_actions:** 比较≤3 条连接走廊；建路；必要时请求 BuildTerrainCrossing；施工后重读拓扑/入口。
- **forbidden_actions:** 严格树状道路教条；把车道数等同道路角色；仅看线段相交；无用途道路。
- **bounded_action_budget:** ≤3 个走廊方案；单阶段≤2 次局部重规划。
- **success_condition:** 目标节点/建筑入口在有效 native 网络上到达指定骨干/外连，且未破坏保护/关键入口。
- **wait_condition:** 仅对短期施工/模拟状态变化等待；connectivity 不明确不能靠时间“等出来”。
- **diagnostic_handoff:** 接入失败→几何/入口/native topology；持续拥堵→RepairTrafficBottleneck。
- **failure_condition:** 有限走廊均被 native/地形/预算拒绝，或需未支持跨越。
- **recovery_handoff:** 局部换走廊、缩小入口、独立 crossing project、换 site。
- **dependencies:** P3/P4/P8；SurveyDevelopmentSite；Finance。
- **conflicts:** 现有 zoning/建筑入口、utility corridors、交通改建。
- **owned_planning_methods:** P3,P4,P8
- **owned_knowledge_rules:** K04,K06,K10,K14,K15
- **hard_invariants:** Road created≠Road Access；geometry intersection≠native connectivity。
- **heuristics:** 道路层级区分 access 与 movement，但必须保留替代路径。
- **version_sensitive_assumptions:** pathfinding、road asset、traffic behavior version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S03 — DeliverProductiveFrontage

- **skill_id:** `skill.S03`
- **skill_name:** DeliverProductiveFrontage
- **purpose:** 交付本期街块真正能生成可用 parcel 的沿街条件。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 项目有有效接入，需交付本期可开发 frontage。
- **required_observation:** 真实道路几何/宽度、native zone cells/road ownership、坡度与两侧可用深度、资产宽深、设施/走廊预留。
- **observation_quality_requirement:** 必须以施工后的 native zone grid/parcel fit 为准；几何预测仅 Estimated。
- **decision_predicates:** 道路合法且两侧有足够建筑深度；street/block 参考系允许局部变化；实际可用 parcel 达到 tranche 需求。
- **priority / arbitration guidance:** 完整可用街块 > 道路数量；保留有理由的留白；优先小范围修正。
- **allowed_actions:** 执行批准 road package；重读 zone grid；≤2 次局部几何修正。
- **forbidden_actions:** 为了补一格 zoning 无限拆路；以道路两端高差替代走廊/地块坡度；把所有留白视为失败。
- **bounded_action_budget:** 继承全局≤3 方案/≤2 局部重规划；禁止连续整段拆建。
- **success_condition:** 本期获得足量实际有效、资产适配、可接 utility 的 frontage/parcel。
- **wait_condition:** 仅等待 native 结果/世界稳定；不等待不存在的 zone grid 自愈。
- **diagnostic_handoff:** 无格→几何/道路 ownership；有格无适配 parcel→P5/asset fit；坡地→site/crossing。
- **failure_condition:** 有限模板和局部调整耗尽仍无法形成 tranche 所需 parcel。
- **recovery_handoff:** 缩小/单侧开发、换模板、换街块/site；保留失败证据。
- **dependencies:** P3/P4/P5；EstablishDistrictAccess。
- **conflicts:** 设施预留、protected corridor、既有建筑/入口。
- **owned_planning_methods:** P3,P4,P5
- **owned_knowledge_rules:** K02,K03,K07–K09,K15
- **hard_invariants:** zone paint/road success 不等于 productive frontage。
- **heuristics:** 山地沿等高线/台地布置；内院/留白可能提高总体效率。
- **version_sensitive_assumptions:** road zoning geometry、asset pack 尺寸 version/DLC-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S04 — ReleaseZoningTranche

- **skill_id:** `skill.S04`
- **skill_name:** ReleaseZoningTranche
- **purpose:** 按真实供给缺口释放有限、可吸收的 R/C/I/O zoning 容量。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 接入、frontage、utility 基线通过；同类型待开发/空置库存不足或类型/位置不适配且有证据。
- **required_observation:** native zone cells、待开发/空置/已入住库存、R/C/I/O demand 及可得因素、住房/岗位/教育/商业经营线索、utility/service 余量。
- **observation_quality_requirement:** 原始 demand 只能作 signal；库存、parcel 与 local service 证据优先；缺关键因素时保守小批或诊断。
- **decision_predicates:** 只有 SUPPLY_SHORTAGE 或经证实的 TYPE/LOCATION_MISMATCH 才追加；mixed-use 同时计住宅+商业；高密按容量而非格数计。
- **priority / arbitration guidance:** 先吸收/修复已有合适库存，再扩供给；住宅/商业/工业/办公独立配额。
- **allowed_actions:** 在批准 parcel 上小批 zoning/dezoning（改建时）；进入 WAITING_FOR_EFFECT。
- **forbidden_actions:** demand 高=立即建；一次铺满；因为 demand 未清零自动追加；碎片格驱动修路。
- **bounded_action_budget:** 每次仅一个批准 tranche；下一批必须经过 S08/S07。
- **success_condition:** 批准 zone cells authoritative readback 正确，随后交 S08；长楼/入住不是即时成功条件。
- **wait_condition:** zoning 完成后进入有界吸收观察。
- **diagnostic_handoff:** 不长楼→S07；需求/库存矛盾→S07；劳动力/教育→S10。
- **failure_condition:** zone 写入/parcel 无效，或供给释放违反 utility/finance/service 条件。
- **recovery_handoff:** 修 parcel/utility；缩小/换 zone type；不靠继续修路掩盖失败。
- **dependencies:** P5/P6/P7；S03/S05/S07/S08。
- **conflicts:** 设施/交通/utility 预留、renewal 保护、污染约束。
- **owned_planning_methods:** P5,P6,P7
- **owned_knowledge_rules:** K08,K17–K20,K25–K28
- **hard_invariants:** demand≠build order；zoning cells 改色≠有效建筑；不连续叠加未验证供给。
- **heuristics:** 高密用容量 tranche；commercial 看可达顾客/货物/员工；office 仍有通勤。
- **version_sensitive_assumptions:** demand、mixed-use、building upgrade 与资产 spawn 逻辑 version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S05 — CommissionUtilities

- **skill_id:** `skill.S05`
- **skill_name:** CommissionUtilities
- **purpose:** 让目标区域真正获得 electricity / water / sewage，并为已承诺负载保留合理余量。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 开局基础服务；新增 tranche 将消耗容量/分配余量；局部断供或分配瓶颈。
- **required_observation:** 目标区域实际服务、全市供需、局部电网拓扑/转换/输送、取水与水质/补给、污水处理与环境风险、设施运行条件、成本。
- **observation_quality_requirement:** 全市总量仅背景；成功必须有 local/target authoritative service evidence；水流/污染未知时不得推断安全。
- **decision_predicates:** 电力区分生产/进口、转换、输送、连通；水区分取水量/水质/补给/连通；污水区分收集/处理/排放/二次固废。
- **priority / arbitration guidance:** 先修连接/分配/物流，再建额外产能；扩建/升级/重连优于无诊断复制设施。
- **allowed_actions:** 部署/连接/升级已认证 utility recipe；逐项验收；必要时限制新增负载。
- **forbidden_actions:** 总发电>需求⇒新区有电；“离得远”替代水流污染证据；连续建多个未运行设施；固定全年 reserve%。
- **bounded_action_budget:** ≤3 个完整方案；每次只实施一个主要干预并验收。
- **success_condition:** 目标区域实际供给可用，未供应量消除/受控，且已承诺 tranche 有经上下文验证的余量。
- **wait_condition:** 设施启动/网络传播需要时间时 bounded wait；若无 local evidence 不以时间代替验收。
- **diagnostic_handoff:** 容量/转换/线路/断连/燃料/水源/污染/污水/固废分别分类。
- **failure_condition:** 关键安全或 local service 无法验证；有限方案均不满足预算/环境/容量。
- **recovery_handoff:** 重连、换设施/recipe、缩小 tranche、换 site；不盲目加厂。
- **dependencies:** P1/P2/P7/P8；Road access；Finance。
- **conflicts:** 污染产业、水源保护、土地/交通走廊、财政节流。
- **owned_planning_methods:** P1,P2,P7,P8
- **owned_knowledge_rules:** K05,K35–K42
- **hard_invariants:** utility total capacity≠local fulfillment；building exists≠utility delivered。
- **heuristics:** 水塔可在经版本确认后作为更易认证的早期选项；能源 margin 随负载/间歇性变化。
- **version_sensitive_assumptions:** utility assets、能耗、污染、水系统与车辆/燃料逻辑 version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S06 — StabilizeFinance

- **skill_id:** `skill.S06`
- **skill_name:** StabilizeFinance
- **purpose:** 维持城市到下一批效果显现所需的现金跑道与可持续经营，而非追求每个瞬间月结为正。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 跑道低、持续亏损、项目超支、服务/utility 成本将上升、购地/大项目准入。
- **required_observation:** 财库、收入/支出趋势与分项、资本支出、持续费用、已承诺项目、税率/服务预算/费用、债务（若可用）、tile upkeep。
- **observation_quality_requirement:** 一次性奖励与经常收入必须区分；不完整费用用保守上界；菜单 upkeep 不视作总成本。
- **decision_predicates:** 保守情景下能撑到当前 tranche 产生收入/效果；税/预算调整有明确目的；贷款仅解除有偿还路径的已证明瓶颈。
- **priority / arbitration guidance:** 保护生存级 utilities/关键服务；先暂停未承诺投资，再做有限经济参数调整；生产性最小分期可作为止损。
- **allowed_actions:** 暂停新资本项目、有限调税/预算/费用、缩小/延后项目、在政策允许时贷款/购地。
- **forbidden_actions:** 开局负月结即冻结增长；每 tick 调税；把低利用率服务一律砍半；贷款续永久结构性亏损。
- **bounded_action_budget:** 每观察窗口只改少数经济参数；重大资本动作需重新 P7。
- **success_condition:** 达到预设跑道/趋势并跨多个窗口维持，且没有破坏生存级服务。
- **wait_condition:** 经济调整后必须留有有界观察窗；不能因短期波动连续反向调整。
- **diagnostic_handoff:** 收入下降→住房/企业/税基；支出→服务/utility/land；缺口与增长互锁→S07。
- **failure_condition:** 可控支出已耗尽仍不可持续；或数据不足无法保证底线。
- **recovery_handoff:** 缩小增长、延后非关键服务、恢复收入型 tranche、显式危机/人工救援。
- **dependencies:** P7/P8；所有资本技能。
- **conflicts:** service/utility 生存底线、已承诺项目、land expansion。
- **owned_planning_methods:** P7,P8
- **owned_knowledge_rules:** K29–K34
- **hard_invariants:** runway 优先于单点月结；成本含资本+持续+资源+连接+土地边际负担。
- **heuristics:** 小幅税率调整+观察；贷款只为可证明瓶颈。
- **version_sensitive_assumptions:** 税/预算/贷款/tile upkeep 数值与经济模型 version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S07 — DiagnoseGrowthBlockage

- **skill_id:** `skill.S07`
- **skill_name:** DiagnoseGrowthBlockage
- **purpose:** 对“需求有但不增长/建筑空/企业失败/项目停滞”给出证据化瓶颈分类，而非立即建设。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 超过正常吸收窗口；需求与库存矛盾；企业/住房/服务长期不履约；重复失败。
- **required_observation:** 动作 readback、parcel、建筑/住户/岗位、utility/服务、库存、劳动力/收入/顾客/货物、时间窗、版本/资产异常。
- **observation_quality_requirement:** 按 observed/derived/estimated 分层；缺项明确 UNKNOWN；不得输出伪精确概率。
- **decision_predicates:** 依次排除命令未生效→parcel→建筑→入住/经营→access/utility→库存→labor/customer/goods→正常时滞→版本异常。
- **priority / arbitration guidance:** 先验证最靠近失败链的事实；诊断不抢占正在验证的项目状态。
- **allowed_actions:** 只读观测、低成本 probe、输出 SUPPLY_SHORTAGE / ABSORPTION_BLOCKED / PENDING_EFFECT / MARKET_MISMATCH / INFRA_FAILURE / VERSION_SUSPECT / UNKNOWN。
- **forbidden_actions:** 把 demand 当根因；为验证猜测反复拆建；症状像已知 bug 就直接判 bug。
- **bounded_action_budget:** 有限 probe；不建立无限诊断循环。
- **success_condition:** 找到一个可行动主要瓶颈或明确列出阻止判断的关键 telemetry。
- **wait_condition:** 只有证据显示仍处正常成熟窗口才交 S08。
- **diagnostic_handoff:** 本技能即诊断 owner；按类别 handoff 到 S03/S05/S09/S10/S11/S12/S15。
- **failure_condition:** 关键证据不可得且没有安全的保守动作。
- **recovery_handoff:** 安全暂停相关扩张；请求所缺观测/人工；不通过新 project id 洗历史。
- **dependencies:** S08、world observations、version profile。
- **conflicts:** 诊断期间保护相关 tranche 不被无关写操作污染。
- **owned_planning_methods:** P8（仅方案比较，不赋予施工权）
- **owned_knowledge_rules:** K20–K28,K43–K51,K65–K66
- **hard_invariants:** UNKNOWN≠PASS；症状≠根因；短期变化不等于长期效果。
- **heuristics:** 优先区分 supply shortage、absorption blocked、pending effect、market mismatch。
- **version_sensitive_assumptions:** demand、pathfinding、service/industry bug patterns 高度 version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S08 — ObserveDevelopmentAbsorption

- **skill_id:** `skill.S08`
- **skill_name:** ObserveDevelopmentAbsorption
- **purpose:** 把“等待”变成有起点、指标、最短/正常/绝对最大窗口的正式玩法动作。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** zoning、设施、utility、经济或交通干预完成且效果具有模拟时滞。
- **required_observation:** 批次基线：建筑、住户/空置、岗位/企业、人口、收入、service/utility、交通目标指标；模拟时间。
- **observation_quality_requirement:** 使用模拟时间而非墙钟；轻微波动不能无限重置最大窗口。
- **decision_predicates:** 已有合适库存且正在吸收→等待；吸收快且余量充足、供给仍短缺→允许下一 tranche；不吸收且有故障证据→诊断。
- **priority / arbitration guidance:** 保护正在验证的批次；安全故障可抢占。
- **allowed_actions:** 推进模拟、采样、在条件达到时结束并 handoff。
- **forbidden_actions:** 无界等待；等待期间连续追加同类供给/设施；用 action count 证明进展。
- **bounded_action_budget:** 每类效果有版本实测最短/正常/绝对最大窗口；绝对窗口不因小变化重置。
- **success_condition:** 效果契约达标，或产生足够证据转 S07。
- **wait_condition:** 本技能本身定义 wait；必须 bounded。
- **diagnostic_handoff:** 超时/反向变化→S07；财政/utility 安全线触发→S06/S05。
- **failure_condition:** 绝对最大窗口到达且既未达标也无安全继续理由。
- **recovery_handoff:** 诊断、缩小/停止后续 tranche、回滚未生效承诺（非盲拆）。
- **dependencies:** 统一模拟时钟/ledger；各建设 Skill。
- **conflicts:** 同一 tranche 的 demolition/rezoning/大规模 network change。
- **owned_planning_methods:** P6
- **owned_knowledge_rules:** K18,K20,K28,K30,K53,K63,K66
- **hard_invariants:** 等待必须 bounded；同类未验证供给不得叠加。
- **heuristics:** 入住潮只在证据表明为临时流且关键服务无恶化时等待。
- **version_sensitive_assumptions:** 成熟时间分布、搬迁/升级/流量行为 version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S09 — ProvisionEssentialServices

- **skill_id:** `skill.S09`
- **skill_name:** ProvisionEssentialServices
- **purpose:** 按真实 deficit/capacity/coverage/fulfillment 增配 education、healthcare、fire、police、garbage、deathcare、road maintenance，并在证据支持时处理 mail/telecom。
- **applicable_city_phase:** EARLY / MID / LARGE；服务种类随解锁和真实缺口出现。
- **trigger:** 积压/响应/有效容量/覆盖/运行效率持续不足，或已批准增长将明确超出承载。
- **required_observation:** 设施有效容量、员工、资源/药品/燃料、车辆、积压、响应路径、district assignment、运行效率、相关污染/疾病/年龄结构。
- **observation_quality_requirement:** building exists/coverage color 不等于 fulfillment；需要实际运行与结果指标；缺 telemetry 时不按人口比例硬推。
- **decision_predicates:** 先检查现有设施为什么没履约，再比较 budget/upgrade/assignment/path/new build；每个服务使用自己的瓶颈链。
- **priority / arbitration guidance:** 生命/消防/垃圾/关键道路等硬故障优先；教育是中长期 capacity，不因短期人口跳升盲建。
- **allowed_actions:** 预算/升级/分配/路径修复/单个设施建设；验证后才可追加。
- **forbidden_actions:** 按人口阈值机械盖；连续建设多个未验证同类设施；低利用率=多余；有余量设施=远区一定获服务。
- **bounded_action_budget:** 每一已证明瓶颈一次一个主要干预；观察后再追加。
- **success_condition:** 相关积压/响应/可用容量/履约在目标区域改善，设施实际运行。
- **wait_condition:** 车辆/服务传播有明确下降趋势时 bounded wait。
- **diagnostic_handoff:** garbage 收集/运输/储存/处理；health disease/medicine/path；deathcare pickup/capacity；fire risk/response；police risk/response/custody；school seats/location；road maintenance critical chain；mail/telecom efficiency。
- **failure_condition:** 干预未改善或关键 telemetry 缺失。
- **recovery_handoff:** 回到履约链诊断；调整 assignment/path/budget/upgrade，最后才新建设施。
- **dependencies:** P2/P6/P7/P8；Finance、Road/Traffic、Utilities。
- **conflicts:** 财政削减、road works、district rules、renewal。
- **owned_planning_methods:** P2,P6,P7,P8
- **owned_knowledge_rules:** K42–K52
- **hard_invariants:** 设施存在≠服务履约；服务容量总量≠片区可达；不按人口阈值机械建设。
- **heuristics:** 消防按风险而非历史利用率；学校按学生位置与容量；关键道路维护优先服务供应链。
- **version_sensitive_assumptions:** garbage routing、education demand、mail/telecom quant effects、service assets version-sensitive。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S10 — BalanceHousingJobsEducation

- **skill_id:** `skill.S10`
- **skill_name:** BalanceHousingJobsEducation
- **purpose:** 让住房容量、岗位结构、劳动力教育与通勤可达形成可持续匹配。
- **applicable_city_phase:** MID / LARGE；早期可作为诊断约束。
- **trigger:** 持续失业/岗位空缺、企业效率低、住宅吸收异常、准备密度升级或产业转型。
- **required_observation:** 住房/空置/入住、jobs/free jobs by education、unemployment、worker education、学校容量/在校/毕业趋势、通勤可达。
- **observation_quality_requirement:** 教育层次/地理可达优先于单一就业率；教育时滞必须显式；版本改变招聘/教育需重验证。
- **decision_predicates:** 识别是 housing shortage、job shortage、education mismatch、access mismatch 还是 recruitment lag；高教育向下填岗可作当前强机制假设但需版本回归。
- **priority / arbitration guidance:** 修最主要结构性失衡；不同时大扩住房和岗位掩盖根因。
- **allowed_actions:** 请求小批住房/就业 zoning、教育服务、交通连接；减缓不匹配供给。
- **forbidden_actions:** 为保低技能工人默认限制教育；把学校当即时劳动力生成器；office 当无交通税源。
- **bounded_action_budget:** 每期处理一个主要结构失衡；教育预测用保守区间。
- **success_condition:** 目标教育层次的 free jobs/unemployment/matching 趋势改善，或教育 pipeline 被正确建立并单独跟踪。
- **wait_condition:** 教育毕业/招聘需 bounded long-horizon observation。
- **diagnostic_handoff:** S07；商业/产业物流→S15；通勤→S11/S13。
- **failure_condition:** 数据无法区分结构失衡，或干预跨窗口无改善。
- **recovery_handoff:** 缩小相应 zoning、改善 access、调整教育/产业节奏。
- **dependencies:** P2/P6/P7；S04/S08/S09/S13。
- **conflicts:** 快速 densification、产业搬迁、service capacity。
- **owned_planning_methods:** P2,P6,P7
- **owned_knowledge_rules:** K17,K21–K24,K27–K28,K48
- **hard_invariants:** 教育有时滞；住宅/岗位/教育不可只看总量。
- **heuristics:** 高教育劳动力向下填岗目前作为强但需回归的机制假设。
- **version_sensitive_assumptions:** education/recruitment/demand 2026 已有平衡改动，必须 version-sensitive。
- **production_relevance:** `MID_CITY_REQUIRED`

### skill.S11 — RepairTrafficBottleneck

- **skill_id:** `skill.S11`
- **skill_name:** RepairTrafficBottleneck
- **purpose:** 修复经多窗口证明的瓶颈，恢复人员、货运和服务出行，而不是最大化车道/速度。
- **applicable_city_phase:** MID / LARGE；早期仅关键接入故障。
- **trigger:** 持续队列/低速/行程失败/服务或货运受阻，并排除短期 transient。
- **required_observation:** 路段速度/流量/队列、转向/路口、关键路径、相邻网络、活动完成；中大型需局部 OD/route evidence。
- **observation_quality_requirement:** 单张红色热图不够；必须跨窗口且能区分 blocked turn、capacity、routing、downstream spillback、transient。
- **decision_predicates:** 先等 transient（若证据足）；再比较路口/转向、补连接、局部拓宽、主动出行/公交、目的地/货运重排。
- **priority / arbitration guidance:** 一次一个主要干预，先解决最窄可证明瓶颈；保护关键 service/freight routes。
- **allowed_actions:** 有限 road/intersection/network intervention；可请求 S13/S14/S15。
- **forbidden_actions:** 短期入住潮立即修路；见堵即拓宽；环岛当万能容量升级；改善只看路更空。
- **bounded_action_budget:** ≤3 个候选方案；每轮1个主要干预；干预后完整观察窗口。
- **success_condition:** 目标瓶颈改善且活动/出行仍完成，相邻网络无更严重退化。
- **wait_condition:** 仅 transient 有证据且强度递减时。
- **diagnostic_handoff:** turn opportunity、queue storage、route choice、parking/pedestrian/transit/freight coupling。
- **failure_condition:** 有限干预无改善或需要缺失能力/telemetry。
- **recovery_handoff:** 撤销/停止后续改动；换诊断类别；必要时 S12。
- **dependencies:** P4/P8；traffic telemetry；S08。
- **conflicts:** 新区道路施工、renewal、transit works。
- **owned_planning_methods:** P4,P8
- **owned_knowledge_rules:** K10–K15,K49,K53–K55,K58,K66
- **hard_invariants:** 短期潮汐≠永久瓶颈；“路更空”必须排除出行丢失/活动崩塌。
- **heuristics:** 路口间距由队列存储决定；环岛只是一类方案。
- **version_sensitive_assumptions:** vehicle pathfinding/lane change/traffic fixes highly version-sensitive。
- **production_relevance:** `MID_CITY_REQUIRED`

### skill.S12 — RecoverDevelopmentProject

- **skill_id:** `skill.S12`
- **skill_name:** RecoverDevelopmentProject
- **purpose:** 把失败转为有界的 reconcile→最小修复→局部改法→缩期→换 site→放弃/安全停止。
- **applicable_city_phase:** EARLY / MID / LARGE。
- **trigger:** 动作结果 UNKNOWN、阶段失败、预算耗尽、世界被手动改动、依赖失效、长期无进展。
- **required_observation:** authoritative world readback、失败原因、父项目累计预算/attempts、依赖状态、实际已交付资产。
- **observation_quality_requirement:** OUTCOME_UNKNOWN 必须先 reconcile；失败历史按目标/地点/原因继承。
- **decision_predicates:** 只有相关前提变化才允许同一确定性失败重新进入可行集；继续必须证明更改了因果前提。
- **priority / arbitration guidance:** 先避免重复副作用；再最小修复；安全停止优于随机尝试。
- **allowed_actions:** reconcile、局部修复/换方法、缩 tranche、re-site、abandon、SAFE_PAUSED/人工救援。
- **forbidden_actions:** 换 project id 清空历史；UNKNOWN 当 PASS/FAIL；无限 retry/replan；把拆除当默认 retry。
- **bounded_action_budget:** 沿父项目累计，子任务不可重置；同一局部目标≤3 方案、≤2 局部重规划。
- **success_condition:** 项目恢复到可证实执行状态，或以明确资源结算的终态退出。
- **wait_condition:** 仅等待明确会改变前提的事实，且 bounded。
- **diagnostic_handoff:** 故障上下文转对应 S03/S05/S06/S07/S09/S11 等。
- **failure_condition:** 无法证明安全继续，进入明确终态。
- **recovery_handoff:** 本技能就是 recovery owner；必要时人工/AI rescue 但不绕过政策。
- **dependencies:** 所有技能的真实 readback/ledger。
- **conflicts:** 不得绕过 Finance/保护区/权限/硬不变量。
- **owned_planning_methods:** P8
- **owned_knowledge_rules:** K30,K33,K52,K64–K65
- **hard_invariants:** UNKNOWN≠PASS；失败历史不可通过 ID 洗掉；retry 必须有因果前提变化。
- **heuristics:** 先最小修复，再缩期/换 site；已入住/关键基础设施不是廉价 retry 材料。
- **version_sensitive_assumptions:** native reject/timeout 行为和特定 bug version-sensitive，但 recovery 原则稳定。
- **production_relevance:** `EARLY_REQUIRED`

### skill.S13 — EstablishAndAdjustTransitService

- **skill_id:** `skill.S13`
- **skill_name:** EstablishAndAdjustTransitService
- **purpose:** 交付并调节完整公共交通服务链，按走廊需求选择 bus/tram/metro/rail，而非按人口解锁机械升级。
- **applicable_city_phase:** MID / LARGE。
- **trigger:** 持续跨区客流/可达性问题、停车/道路容量约束、已存在 transit 服务运力/可靠性不足。
- **required_observation:** depot/vehicle、network/waypoint、stop/platform、line、运行周期、等待/上客/满载、入口/出口队列、走廊 OD/需求。
- **observation_quality_requirement:** “建站”或“有线路”不算履约；至少完整运行周期+乘客完成证据。
- **decision_predicates:** 先确定服务走廊与目标；bus 优化、tram、metro/rail 比较完整成本与是否绕开瓶颈；拥堵先区分运力不足 vs bunching/platform/entry/route。
- **priority / arbitration guidance:** 先优化已有线/站/waypoint，再升级模式；覆盖与高频主干均可，按目标权衡。
- **allowed_actions:** 建/改 stop、line、vehicle allocation、waypoint、mode/corridor（能力支持时）。
- **forbidden_actions:** 按人口阈值上地铁；客多就只加车；有 station building=服务已交付；强制所有线路 feeder。
- **bounded_action_budget:** 每次一个走廊级干预；完整周期观察后再加运力/升级。
- **success_condition:** 目标可达/等待/完成行程改善，车辆能正常运行，不把队列转移到街道。
- **wait_condition:** 至少一个完整运行周期；高峰/昼夜需对应窗口。
- **diagnostic_handoff:** capacity、bunching、platform、entry/exit、route/waypoint、mode mismatch。
- **failure_condition:** 线路无法完成运行或干预不改善走廊目标。
- **recovery_handoff:** 回退到更简单 mode/route、修站台/道路、缩短/重组线路。
- **dependencies:** P2/P4/P7/P8；Traffic、Active Mobility、Finance。
- **conflicts:** road works、parking policy、freight corridor。
- **owned_planning_methods:** P2,P4,P7,P8
- **owned_knowledge_rules:** K57–K60
- **hard_invariants:** transit=depot→network→stop→line→vehicle→actual operation。
- **heuristics:** tram/metro only when corridor and priority/grade separation justify them。
- **version_sensitive_assumptions:** vehicle/pathfinding/timetable/asset behavior version-sensitive；模组时刻表规则不得当 base-game hard rule。
- **production_relevance:** `MID_CITY_REQUIRED`

### skill.S14 — ManageParkingWalkingCyclingAccess

- **skill_id:** `skill.S14`
- **skill_name:** ManageParkingWalkingCyclingAccess
- **purpose:** 把停车、步行、骑行作为方式选择与目的地可达的联合系统，而非独立最大化任何一项。
- **applicable_city_phase:** MID / LARGE；步行连接可从 EARLY 使用。
- **trigger:** 停车供需/拥堵、步行热点、骑行/公共交通接驳、目的地 access 问题。
- **required_observation:** 停车容量/占用/收费、步行网络与过街、bike eligibility/parking/lane/path、目的地活动完成、交通/公交替代方案。
- **observation_quality_requirement:** 停车减少后要验证 mode shift vs trip suppression；行人多先视为活动成功信号再诊断冲突。
- **decision_predicates:** 限制/提价停车前必须存在可行替代；骑行低先查是否进入候选方式+目的地停车；步行冲突优先改善连接/过街而非删除需求。
- **priority / arbitration guidance:** 安全与实际可达优先；与 transit/road joint optimization。
- **allowed_actions:** 停车供应/收费/道路停车调整、步行连接/过街、bike lane/path/parking（能力支持时）。
- **forbidden_actions:** 停车越多越好；删停车必然转公交；为汽车流简单删除必要过街；只铺 bike lane 不检查停车/方式资格。
- **bounded_action_budget:** 一次改变一个主要 access lever，观察目的地与 mode 结果。
- **success_condition:** 目的地活动保持/提高，目标拥堵或 mode access 改善。
- **wait_condition:** 方式选择变化需 bounded multi-window 观察。
- **diagnostic_handoff:** parking shortage/induced driving/trip suppression、ped crossing conflict、bike eligibility/parking。
- **failure_condition:** 活动完成下降或替代方式不可用。
- **recovery_handoff:** 恢复必要 access、补替代方式、调整收费/布局。
- **dependencies:** S11/S13；P2/P3/P8。
- **conflicts:** 商业/服务 access、货运、道路层级。
- **owned_planning_methods:** P2,P3,P8
- **owned_knowledge_rules:** K54–K56
- **hard_invariants:** 停车政策效果必须看活动是否完成；active mode 需要完整可达链。
- **heuristics:** 行人多通常先是成功信号；停车减少可能抑制目的地而非自动换方式。
- **version_sensitive_assumptions:** bike trips 2026 已被大幅平衡，必须 runtime/version-sensitive。
- **production_relevance:** `MID_CITY_REQUIRED`

### skill.S15 — ManageFreightIndustrialLogistics

- **skill_id:** `skill.S15`
- **skill_name:** ManageFreightIndustrialLogistics
- **purpose:** 让产业/商业的原料、货物、员工与货运连接形成真实物流链，不追求全资源自产或只看货站库存。
- **applicable_city_phase:** MID / LARGE。
- **trigger:** 工业/商业效率差、货物短缺、重型卡车瓶颈、资源专业化/货站/港口机会。
- **required_observation:** 产销/库存/资源、进出口、运输重量/路径、员工、货站/港口实际装卸/线路、last-mile roads、污染。
- **observation_quality_requirement:** terminal inventory≠rail/water freight success；企业利润/销售≠市政收入；资源参数 version-sensitive。
- **decision_predicates:** 区分 goods shortage、customer shortage、labor/access、transport cost；本地链条只在资源/污染/土地/劳动力/运输综合上成立。
- **priority / arbitration guidance:** 先修链条瓶颈；重/高运输成本资源更值得本地化；货运节点要同时验收干线和末端。
- **allowed_actions:** 小批产业 zoning、物流连接/terminal/route、道路/rail/water cargo 改善（能力支持时）。
- **forbidden_actions:** 全部自产；工业一律放最远；有货站库存=已减少卡车；office 无限替代工业。
- **bounded_action_budget:** 一次一个主要 supply-chain/connection intervention。
- **success_condition:** 目标货物流/企业供给/运输完成改善，且 last-mile/污染/劳动力未恶化。
- **wait_condition:** 生产/库存/贸易变化按统计窗口 bounded 观察。
- **diagnostic_handoff:** production、inventory、transport、customer、labor、pollution。
- **failure_condition:** 物流节点不实际运输或成本/污染/劳动力代价超过收益。
- **recovery_handoff:** 缩产业 tranche、改 route/terminal、回归贸易、重排 site。
- **dependencies:** P2/P4/P7/P8；Traffic、Utilities、Labor。
- **conflicts:** 住宅污染、水源、traffic/transit corridors。
- **owned_planning_methods:** P2,P4,P7,P8
- **owned_knowledge_rules:** K23,K25–K27,K37,K61–K62
- **hard_invariants:** 物流履约必须看真实运输完成；industrial siting 同时优化污染+货运+员工可达。
- **heuristics:** 运输重、昂贵的链条优先本地化；货站可有仓储价值但不等于运输价值。
- **version_sensitive_assumptions:** production chain/transport/pathfinding/cargo assets version-sensitive。
- **production_relevance:** `MID_CITY_REQUIRED`

### skill.S16 — RenewOrDensifyDistrict

- **skill_id:** `skill.S16`
- **skill_name:** RenewOrDensifyDistrict
- **purpose:** 在旧区增密/改建时先交付替代能力，再分段撤销旧能力，避免用 demolition 作为 retry。
- **applicable_city_phase:** MID / LARGE，LARGE 更关键。
- **trigger:** 旧区土地效率/住房类型/服务/网络不再满足目标，或需 corridor/service renewal。
- **required_observation:** 现有住房/岗位/服务/utility/交通功能、入住/企业、替代容量、污染历史、road/zone impact。
- **observation_quality_requirement:** 必须知道被拆资产承担的功能及替代是否实际运行；计划中的替代不算。
- **decision_predicates:** 旧能力的替代已 live；改建收益大于搬迁/服务/网络破坏；新 zoning 有真实需求和 asset fit。
- **priority / arbitration guidance:** 最小影响区、分段切换；关键连接/utility 双活后再撤旧。
- **allowed_actions:** rezone、局部 relocation/upgrade removal、road/service replacement、分段 demolition（能力支持时）。
- **forbidden_actions:** 先拆后想；新容量仅 planned 就撤旧；已入住住宅/关键基础设施当廉价 retry。
- **bounded_action_budget:** 每次只更新一个可隔离子区/功能；观察迁移/服务后再扩大。
- **success_condition:** 替代能力实际运行，旧区目标容量/网络改善，受影响居民/企业/服务可过渡。
- **wait_condition:** replacement/relocation/absorption bounded wait。
- **diagnostic_handoff:** 功能缺失→对应 service/utility/traffic/growth。
- **failure_condition:** 无法证明替代或影响范围不可控。
- **recovery_handoff:** 停止拆除、保留旧能力、缩小 renewal scope。
- **dependencies:** P3/P5/P6/P7/P8；S08/S12。
- **conflicts:** 正在观察的 tranche、唯一网络/utility、historic/protected assets。
- **owned_planning_methods:** P3,P5,P6,P7,P8
- **owned_knowledge_rules:** K15,K28,K52,K64
- **hard_invariants:** replacement live before removal；demolition 不是默认 retry。
- **heuristics:** 先移动/删除 upgrade 或局部重排，再拆整栋/整区。
- **version_sensitive_assumptions:** historic building、asset upgrade/relocation 行为 version-sensitive。
- **production_relevance:** `LARGE_CITY_REQUIRED`

### skill.S17 — BuildTerrainCrossing

- **skill_id:** `skill.S17`
- **skill_name:** BuildTerrainCrossing
- **purpose:** 在地形/水体确实阻断已批准区域目标时，交付桥/隧/局部整地等 crossing；只覆盖资料充分支持的 bounded crossing，不扩成大型地形工程系统。
- **applicable_city_phase:** EARLY / MID / LARGE；困难地图可提前。
- **trigger:** 普通接入走廊无法满足战略目标，且跨越收益被完整方案证明。
- **required_observation:** 两端目标、地形/水体/净空、连接几何、成本、后续 region value、相关水运/道路要求。
- **observation_quality_requirement:** 先证明两端与后续价值；最窄水面/最短线段不是充分依据；native legality 必须验。
- **decision_predicates:** 比较绕行、局部 grading、桥、隧；先定两端/门户再定中间；crossing 必须服务区域项目。
- **priority / arbitration guidance:** 低成本普通走廊优先；跨越仅在解除明确空间/连接约束时。
- **allowed_actions:** 生成/执行已认证 crossing 方案（能力支持时）。
- **forbidden_actions:** 为景观/最短距离无项目目的修大桥；整平整座山作为默认；把 crossing 视为单段 road candidate。
- **bounded_action_budget:** ≤3 crossing alternatives；大规模地形重塑不在本冻结 spec 内。
- **success_condition:** 两端 native 连通、项目目标可达、净空/环境/预算通过。
- **wait_condition:** 仅施工/模拟确认 bounded。
- **diagnostic_handoff:** native geometry/clearance/cost/approach failure。
- **failure_condition:** 所有有限 crossing 不合法/不经济或进入大型地形 mega-project 范围。
- **recovery_handoff:** 绕行、换 site、缩项目；mega-project → MISSING_SPEC/人工。
- **dependencies:** P1/P4/P8；S01/S02/S06。
- **conflicts:** waterway、utility、protected area、future freight/transit。
- **owned_planning_methods:** P1,P4,P8
- **owned_knowledge_rules:** K02–K05
- **hard_invariants:** crossing 是区域项目而非孤立道路；两端/后续价值先于中间几何。
- **heuristics:** 山地优先台地/沿等高线/局部整地；桥不按最窄水面贪心。
- **version_sensitive_assumptions:** bridge/tunnel assets、clearance/terrain rules version-sensitive。
- **production_relevance:** `OPTIONAL_SPECIALIST`

## 6. Domain policies

These policies are the cross-Skill gameplay rules. A Skill may own the action, but the policy owns the domain invariant.

### POL-GROWTH — Growth / Demand / Absorption

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — Demand is an aggregate pressure signal, never a build order.
- `HARD_INVARIANT` — Track at least three stocks separately: zoned-but-undeveloped, built-but-vacant, occupied/operating.
- `STRONG_POLICY` — Before adding supply, distinguish SUPPLY_SHORTAGE, ABSORPTION_BLOCKED, PENDING_EFFECT, TYPE/LOCATION_MISMATCH and UNKNOWN.
- `STRONG_POLICY` — Release supply in bounded tranches and observe before repeating the same supply action.
- `DIAGNOSTIC_HINT` — A high demand bar with stalled development often points to parcel, access, utility, labor/customer/goods or version issues rather than raw land shortage.

### POL-ROAD — Road / Access / Network

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — Road created is not Road Access success; geometry intersection is not native connectivity.
- `STRONG_POLICY` — Every road must have a declared role: access/frontage, district connection, freight/service, redundancy or crossing.
- `STRONG_POLICY` — Use hierarchy as a functional concept, not a strict tree; important districts need reasonable alternate paths.
- `HEURISTIC` — Intersection spacing follows queue-storage and movement evidence, not a universal expert distance.
- `DIAGNOSTIC_HINT` — A new shortcut may attract external-through traffic and must be checked when it changes network cost.

### POL-ZONING — Parcel / Zoning / Density

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — Painted zoning cells do not prove a viable parcel or building spawn.
- `STRONG_POLICY` — Fit zoning to actual parcel width/depth and current asset set; count high-density release by capacity, not just cells.
- `STRONG_POLICY` — Mixed-use capacity must be accounted in both residential and commercial stocks.
- `STRONG_POLICY` — Do not rebuild roads indefinitely to recover a few zoning cells.
- `HEURISTIC` — Purposeful inner-block voids, reservations and terrain buffers can be more efficient than maximizing filled pixels.

### POL-UTILITY — Electricity / Water / Sewage

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — Citywide capacity is not local delivery.
- `STRONG_POLICY` — Electricity diagnosis separates generation/import, transformation, transmission and connection.
- `STRONG_POLICY` — Water/sewage decisions require water-quality/flow or a previously certified conservative recipe; distance alone is not safety evidence.
- `STRONG_POLICY` — Add one major utility intervention at a time and prove operation before adding another.
- `HEURISTIC` — Capacity margin is contextual to committed load, variability and dependency chains; no universal reserve percentage is frozen.

### POL-FINANCE — Finance / Tax / Budget / Land Cost

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — Judge affordability by runway through the effect window, not by one instantaneous monthly balance.
- `STRONG_POLICY` — Use full marginal cost: construction, connection, staff/resources, recurring upkeep, land burden and committed projects.
- `STRONG_POLICY` — Tax and budget changes require a named purpose, small step and observation window.
- `STRONG_POLICY` — Loans are acceptable only to remove a proven temporary bottleneck with a repayment path.
- `HEURISTIC` — A small productive tranche can be the correct response to losses when it completes an income-producing loop.

### POL-SERVICE — Essential Services

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — A service building existing or a coverage overlay being green does not prove fulfillment.
- `STRONG_POLICY` — Use deficit/capacity/coverage/response evidence; never place services solely from population thresholds.
- `STRONG_POLICY` — Check staff/resources/vehicles/path/district assignment before building a duplicate facility.
- `STRONG_POLICY` — One proven bottleneck receives one principal intervention, then observation.
- `DIAGNOSTIC_HINT` — Garbage, healthcare, deathcare, fire, police, education and maintenance each have different fulfillment chains; do not use one generic capacity ratio.

### POL-LABOR — Housing / Jobs / Education

**production_relevance:** `MID_CITY_REQUIRED`

- `HARD_INVARIANT` — Housing, jobs and education must be matched by structure and accessibility, not only citywide totals.
- `STRONG_POLICY` — Education is a delayed pipeline; new school capacity is not immediate skilled labor.
- `STRONG_POLICY` — Do not suppress education by default to preserve low-skill labor.
- `HEURISTIC` — Current source evidence supports higher-education workers filling lower-education jobs, but this remains build-sensitive and should be regression-checked.
- `DIAGNOSTIC_HINT` — Job vacancies can reflect labor, access, business demand/cost or recruitment delay; adding housing is not a universal fix.

### POL-TRAFFIC — Traffic / Bottleneck Repair

**production_relevance:** `MID_CITY_REQUIRED`

- `HARD_INVARIANT` — Do not repair traffic from a short-lived move-in wave without persistent evidence.
- `STRONG_POLICY` — Diagnose turn blocking, opportunity/capacity, spillback, routing and downstream bottlenecks before adding lanes.
- `STRONG_POLICY` — Make one main intervention, then compare before/after over a complete observation window.
- `HARD_INVARIANT` — Lower traffic/shorter queues count as improvement only if trips, services and economic activity still complete.
- `HEURISTIC` — Roundabouts, widening and extra links are solution families, not default upgrades.

### POL-MOBILITY — Parking / Walking / Cycling / Transit

**production_relevance:** `MID_CITY_REQUIRED`

- `STRONG_POLICY` — Parking changes must be evaluated for mode shift versus destination suppression.
- `STRONG_POLICY` — Preserve useful pedestrian access; high pedestrian volumes are often evidence of successful activity, with conflicts treated locally.
- `STRONG_POLICY` — Cycling requires mode eligibility plus a usable route and destination parking.
- `HARD_INVARIANT` — Transit is delivered only when depot/network/stops/line/vehicles actually operate.
- `STRONG_POLICY` — Choose bus/tram/metro/rail by corridor purpose and complete service cost, not population thresholds.

### POL-FREIGHT — Industry / Freight / Supply Chain

**production_relevance:** `MID_CITY_REQUIRED`

- `STRONG_POLICY` — Industrial siting jointly considers pollution exposure, freight access and worker access.
- `STRONG_POLICY` — Do not optimize for full self-sufficiency; localize resource chains when transport, land, pollution and labor make it worthwhile.
- `HARD_INVARIANT` — Cargo-terminal inventory alone does not prove rail/water freight success; verify actual transport and last mile.
- `STRONG_POLICY` — Commercial failure separates customer shortage from goods shortage.
- `HEURISTIC` — Heavy/expensive-to-transport inputs are stronger candidates for local production.

### POL-POLLUTION — Pollution / Water Source Protection

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — Do not infer water safety from distance alone; verify flow/contamination or use a certified safe recipe.
- `STRONG_POLICY` — Protect the full groundwater reservoir where relevant, not only the pump footprint.
- `STRONG_POLICY` — Keep pollution buffers while still preserving worker/logistics access.
- `STRONG_POLICY` — When illness or service load is pollution-driven, remove the source as part of the solution.
- `HEURISTIC` — Noise/air/ground pollution behavior is patch-sensitive; spatial margins should be validated, not hard-coded.

### POL-LAND — Land Expansion / District Expansion / Unlocks

**production_relevance:** `MID_CITY_REQUIRED`

- `STRONG_POLICY` — Open a new district only when it solves a constraint the old district cannot solve economically or safely.
- `STRONG_POLICY` — Compare total post-purchase land burden, not only the new tile price.
- `STRONG_POLICY` — Existing purchased land and densification must be compared against outward expansion.
- `HARD_INVARIANT` — Do not use a population threshold as the sole trigger for a second district.
- `DIAGNOSTIC_HINT` — Exact milestone/unlock optimization is not supported by the frozen source asset and remains MISSING_KNOWLEDGE_ASSET.

### POL-RENEW — Renewal / Demolition / Relocation

**production_relevance:** `LARGE_CITY_REQUIRED`

- `HARD_INVARIANT` — Replacement capacity/network/service must be live before removing an old critical function.
- `STRONG_POLICY` — Renew in bounded subareas and observe migration/service effects before expanding scope.
- `STRONG_POLICY` — Check movable/removable upgrades and local reconfiguration before whole-facility demolition.
- `HARD_INVARIANT` — Demolition is not a generic retry mechanism.
- `DIAGNOSTIC_HINT` — Historic/protected-building behavior and asset relocation rules are version-sensitive.

### POL-RECOVERY — Recovery / Abandon / Re-site

**production_relevance:** `EARLY_REQUIRED`

- `HARD_INVARIANT` — UNKNOWN can never be counted as PASS.
- `HARD_INVARIANT` — Failure history follows the real target/location/cause and cannot be reset with a new project id.
- `STRONG_POLICY` — Recovery ladder: reconcile → fix smallest prerequisite → change local method → shrink tranche → re-site → abandon/safe pause.
- `STRONG_POLICY` — Retry a deterministic failure only after a causally relevant precondition changed.
- `STRONG_POLICY` — Waits and replans are bounded; no indefinite busy-loop counts as progress.

### POL-LONGRUN — Medium/Large Transition / Long-run Stability

**production_relevance:** `LARGE_CITY_REQUIRED`

- `STRONG_POLICY` — Phase transitions are state-based, not population-threshold-based.
- `STRONG_POLICY` — As the city grows, move from single-project delivery to cross-district capacity, redundancy, multimodal mobility, freight and renewal.
- `STRONG_POLICY` — Judge the worst stressed district/critical chain as well as citywide averages.
- `STRONG_POLICY` — Avoid simultaneous unverified interventions that destroy attribution.
- `HARD_INVARIANT` — A stable autonomous mayor must be able to stop safely when evidence or capability is insufficient.

### 6.1 Essential-service subpolicies

| Service | Observe before build | Preferred intervention order | Forbidden shortcut | Strength |
|---|---|---|---|---|
| Education | eligible/student location, seats, attendance/education pipeline, access | existing capacity/access → expansion → new school | total population or all children as school-demand proxy | `STRONG_POLICY` |
| Healthcare | illness source, beds/capacity, staff/medicine/resources, patient pickup/path | remove disease source → restore operation/path → add capacity | build hospital because health alert exists | `STRONG_POLICY` |
| Fire | risk exposure, response path/time, staffing/vehicles, special forest/air capability if applicable | route/coverage/operation → new capacity where risk remains | low historical utilization = redundant | `HEURISTIC` |
| Police | welfare/crime generation, patrol/response, arrest/custody/transfer chain | restore response chain → add capacity if proven | every crime warning = new police station/prison | `DIAGNOSTIC_HINT` |
| Garbage | collection, vehicle routing/load, storage, transfer, treatment | route/assignment/vehicle/storage → treatment expansion | processing capacity total = collection solved | `STRONG_POLICY` |
| Deathcare | dead-body pickup, vehicle/path, storage/processing, aging trend | restore pickup/path → add capacity | reuse Cities: Skylines I death-wave formulas as hard rules | `STRONG_POLICY` |
| Road maintenance | critical-route condition, maintenance vehicles, service/freight dependency | protect critical service/fuel/only-crossing routes first | maintenance vehicle pause = permanent congestion | `STRONG_POLICY` |
| Mail / telecom | explicit efficiency warnings/effects, facility/network capacity where observable | diagnose measurable business/coverage penalty → bounded intervention | build from population threshold or happiness alone | `DIAGNOSTIC_HINT`; quantitative asset incomplete |

### 6.2 Density / R-C-I-O release policy

- **Residential:** choose density/type from household fit, affordability, land/service cost and current vacant/undeveloped stock. Low/medium/high are not interchangeable “demand bars.”
- **Commercial:** use reachable customers, purchasing power, goods supply and workers. Passing road traffic is not a customer pool.
- **Industrial:** jointly optimize resource/logistics, pollution separation and worker access. “Farther from housing is always better” is rejected.
- **Office:** lower freight intensity does not mean low travel demand or unlimited fiscal value; phase by suitable labor and actual absorption.
- **Mixed-use:** count both residential and commercial capacity and validate both functions separately.
- **Release cadence:** use **capacity tranches**, not fixed cell counts, especially for high density.

### 6.3 Utility-capacity margin policy

No fixed universal reserve percentage is frozen.

A margin is acceptable only when it is tied to:
1. current actual load;
2. already committed but not yet realized load;
3. observed variability/temperature/intermittency where relevant;
4. upstream conversion/transmission constraints;
5. failure consequence and recovery time.

The correct default is therefore **contextual reserve with local-delivery proof**, not “always keep X% spare.”

### 6.4 Land / milestone / unlock policy boundary

The frozen asset supports:
- comparing existing land, densification and expansion;
- full marginal tile/upkeep cost;
- only expanding to solve a real constraint;
- checking whether required assets/capabilities are unlocked before approving a plan.

It **does not** contain enough expert evidence to freeze an optimized milestone/development-point/unlock sequence. That is `MISSING_KNOWLEDGE_ASSET`, not permission to invent a tree.

---

## 7. Knowledge Card disposition

Disposition codes:

- **A** — converted into a formal Skill/Planning Method/domain policy rule.
- **B** — merged into a broader rule to remove duplication.
- **C** — retained as heuristic/advisory knowledge.
- **D** — retained but explicitly version-sensitive; must be validated before it can become an action predicate.
- **E** — the original card contains a now-superseded element; only the residual rule named by `merged_into` survives.
- **F** — does not belong in production gameplay decision logic.

**Exactly 66 source cards are accounted for below, once each.**

| card_id | original_topic | final_disposition | owner | merged_into | policy_strength | version_status |
|---|---|---|---|---|---|---|
| K01 | 选址要比较“完整启动成本”，不是只比平坦面积 | C | plan.P8 / skill.S01 | — | `HEURISTIC` | `STABLE_PRINCIPLE` |
| K02 | 山地开发先找台地，再连道路 | C | skill.S01 / plan.P5 | — | `HEURISTIC` | `STABLE_PRINCIPLE` |
| K03 | 道路纵坡与建筑横坡是两个问题 | A | skill.S03 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K04 | 跨山、跨河先定两端，再定中间 | C | skill.S17 / plan.P4 | — | `HEURISTIC` | `STABLE_PRINCIPLE` |
| K05 | “临水”不等于“适合取水、排污或港口” | A | skill.S01 / skill.S05 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_MECHANICS` |
| K06 | 预留未来走廊，不等于现在修未来道路 | A | plan.P3 / plan.P6 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K07 | 分区网格需要一致参考系，不需要全城一个网格 | C | plan.P3 / plan.P5 | — | `HEURISTIC` | `ASSET_SENSITIVE` |
| K08 | “有 zoning cells”不等于有适配建筑地块 | A | skill.S03 / skill.S04 | — | `HARD_INVARIANT` | `ASSET_SENSITIVE` |
| K09 | 留白具有多种价值，不能只有“未开发”一种状态 | A | plan.P2 / plan.P5 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K10 | 道路层级应服务连通，不应制造单点依赖 | A | skill.S02 / skill.S11 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K11 | 路口间距取决于队列存储，不是固定“高手米数” | C | skill.S11 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE` |
| K12 | 转向堵塞先区分“被阻挡”和“根本无通行机会” | B | skill.S11 | POL-TRAFFIC.turn/capacity diagnosis | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K13 | 环岛不是容量升级按钮 | C | skill.S11 | POL-TRAFFIC.solution-family | `HEURISTIC` | `VERSION_SENSITIVE` |
| K14 | 新连接可能吸引无关过境交通 | D | skill.S02 / skill.S11 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_PATHFINDING` |
| K15 | 改路的影响区大于道路本身 | D | skill.S03 / skill.S16 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_NATIVE_GEOMETRY` |
| K16 | 显示速度、内部数值、模拟时间不可混用 | F | Implementation data-contract note | — | `DIAGNOSTIC_HINT` | `NOT_GAMEPLAY_POLICY` |
| K17 | 住宅容量选择应基于家庭与负担，不是密度条竞争 | A | skill.S04 / skill.S10 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_DEMAND` |
| K18 | 高密单栋容量大，释放单位应是容量批次而非格数 | B | skill.S04 | POL-ZONING.capacity-tranche | `STRONG_POLICY` | `ASSET_SENSITIVE` |
| K19 | 混合用途不能只按住宅计账 | D | skill.S04 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_MIXED_USE` |
| K20 | 待开发、空置、已入住是三个库存 | A | skill.S04 / skill.S07 / skill.S08 | — | `HARD_INVARIANT` | `STABLE_PRINCIPLE` |
| K21 | 高租金通知应触发收入诊断，不是“降地价” | A | skill.S07 / skill.S10 | — | `DIAGNOSTIC_HINT` | `CURRENT_MECHANIC_BUT_VERSION_SENSITIVE` |
| K22 | 高教育劳动力可以向下填岗 | D | skill.S10 | — | `HEURISTIC` | `VERSION_SENSITIVE_EDUCATION_EMPLOYMENT` |
| K23 | 企业裁员可能是需求/成本调整 | B | skill.S07 / skill.S10 | POL-GROWTH.enterprise-diagnosis | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_ECONOMY` |
| K24 | 教育是年龄、资格、选择与毕业时滞的管线 | D | skill.S10 / skill.S09 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_EDUCATION` |
| K25 | 商业选址看可达顾客，不看“道路车很多” | A | skill.S04 / skill.S15 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_PATHFINDING` |
| K26 | “没顾客”和“没货”可能产生相似经营失败 | B | skill.S07 / skill.S15 | POL-GROWTH.commercial-diagnosis | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_ECONOMY` |
| K27 | Office 少货运，不等于少交通或无限税源 | A | skill.S10 / skill.S15 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K28 | 建筑升级会在没有新 zoning 时增加城市负荷 | D | skill.S04 / skill.S10 / skill.S16 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_BUILDING_LEVELING` |
| K29 | 菜单 upkeep 不是完整经营费用 | B | skill.S06 / plan.P7 | POL-FINANCE.full-marginal-cost | `STRONG_POLICY` | `ASSET_SENSITIVE` |
| K30 | 等待需要跑道，扩张也可能是止损措施 | A | skill.S06 / plan.P7 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K31 | 税率是需求与经营干预，不存在已证明的全局最佳值 | A | skill.S06 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_ECONOMY` |
| K32 | 降预算改变服务能力，不只是打折 | A | skill.S06 / skill.S09 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_SERVICE_BUDGET` |
| K33 | 借贷应解除可证明瓶颈，不应为永久亏损续命 | C | skill.S06 | — | `HEURISTIC` | `VERSION_SENSITIVE_LOANS` |
| K34 | 购地的边际费用可能包含旧购地维护上涨 | D | skill.S01 / skill.S06 / POL-LAND | — | `STRONG_POLICY` | `VERSION_SENSITIVE_TILE_UPKEEP` |
| K35 | 缺电先定位生产、转换、输送或连通 | A | skill.S05 | — | `HARD_INVARIANT` | `STABLE_MECHANIC_CLASS` |
| K36 | 电力保障必须绑定区域与路径 | B | skill.S05 | POL-UTILITY.local-delivery | `HARD_INVARIANT` | `STABLE_PRINCIPLE` |
| K37 | 燃料电厂是一条物流链，不只是 MW 数字 | A | skill.S05 / skill.S15 | — | `STRONG_POLICY` | `ASSET_SENSITIVE` |
| K38 | 能源余量应覆盖温度与间歇性，不用固定全年百分比 | C | skill.S05 / plan.P7 | — | `HEURISTIC` | `VERSION_SENSITIVE_LOAD_PROFILE` |
| K39 | 污水口“远离水泵”不如“污染不会到达水泵”可靠 | A | skill.S05 / POL-POLLUTION | — | `HARD_INVARIANT` | `STABLE_PRINCIPLE` |
| K40 | 地下水需要按整个储层保护和持续产能管理 | A | skill.S05 / POL-POLLUTION | — | `STRONG_POLICY` | `VERSION_SENSITIVE_GROUNDWATER` |
| K41 | 水塔可能是更贵但更易认证的早期方案 | C | skill.S05 | — | `HEURISTIC` | `VERSION_SENSITIVE_ASSET_COST` |
| K42 | 污水处理会产生固废，可能转移而非消灭瓶颈 | A | skill.S05 / skill.S09 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_SERVICE_CHAIN` |
| K43 | 垃圾故障至少分收集、运输、储存、处理四段 | D | skill.S09 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_GARBAGE_ROUTING` |
| K44 | 医疗扩建前先查疾病来源和药品供应 | A | skill.S09 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_HEALTH_SYSTEM` |
| K45 | 殡葬需要区分尸体收运与设施容纳/处理 | A | skill.S09 | — | `STRONG_POLICY` | `STABLE_PRINCIPLE` |
| K46 | 消防低利用率不能证明多余 | C | skill.S09 | — | `HEURISTIC` | `VERSION_SENSITIVE_RISK_MODEL` |
| K47 | 治安问题可能是低福祉，也可能是响应失败 | C | skill.S09 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_CRIME_RESPONSE` |
| K48 | 学校扩建与新建取决于学生在哪里 | A | skill.S09 / skill.S10 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_EDUCATION` |
| K49 | 道路维护保护的是服务供应链 | A | skill.S09 / skill.S11 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_ROAD_MAINTENANCE` |
| K50 | District 服务分配可能把一座有余量的设施“隔离”掉 | A | skill.S09 | — | `HARD_INVARIANT` | `VERSION_SENSITIVE_DISTRICT_ASSIGNMENT` |
| K51 | 邮政和通信可以影响企业效率，不只是幸福装饰 | D | skill.S09 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_QUANT_EFFECT` |
| K52 | 先检查可移动/可删除升级，再拆整座设施 | C | skill.S09 / skill.S16 | — | `HEURISTIC` | `ASSET_SENSITIVE` |
| K53 | 等入住潮需要证据，不是所有拥堵都“再等等” | E | skill.S08 / skill.S11 | POL-TRAFFIC.transient-wait-rule | `STRONG_POLICY` | `PARTIALLY_SUPERSEDED_2026_MOVE_IN_TRAFFIC` |
| K54 | 限制停车可能改变目的地，不只改变出行方式 | A | skill.S14 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_MODE_CHOICE` |
| K55 | 行人很多首先是成功信号，但交叉冲突需要处理 | A | skill.S14 / skill.S11 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_PEDESTRIAN_BEHAVIOR` |
| K56 | 骑行需要“进入候选方式集合”与“目的地停车” | D | skill.S14 | — | `STRONG_POLICY` | `VERSION_SENSITIVE_BIKE_BALANCE_2026` |
| K57 | 公交交付是完整服务链，不是“建站” | A | skill.S13 | — | `HARD_INVARIANT` | `STABLE_PRINCIPLE` |
| K58 | 公交拥堵先查站台和运行周期，再加车 | C | skill.S13 / skill.S11 | — | `HEURISTIC` | `VERSION_SENSITIVE_TRANSIT_OPERATION` |
| K59 | Tram 的收益取决于走廊与优先权，不只取决于单车容量 | C | skill.S13 | — | `HEURISTIC` | `VERSION_SENSITIVE_TRANSIT_ASSETS` |
| K60 | Metro/铁路按整条服务走廊准入，不按人口解锁 | C | skill.S13 | — | `HEURISTIC` | `VERSION_SENSITIVE_TRANSIT_ASSETS` |
| K61 | 产业专业化应看运输重量与本地链条，不追求全部自产 | D | skill.S15 | — | `HEURISTIC` | `VERSION_SENSITIVE_PRODUCTION_CHAIN` |
| K62 | 货站可以有仓储价值，但“有库存”不等于运输成功 | A | skill.S15 | — | `HARD_INVARIANT` | `VERSION_SENSITIVE_CARGO_OPERATION` |
| K63 | 第二片区不必等旧区满员，但必须说明它解决什么 | C | POL-LAND / POL-LONGRUN | — | `HEURISTIC` | `STABLE_PRINCIPLE` |
| K64 | 更新改建先交付替代能力，再撤销旧能力 | A | skill.S16 / skill.S12 | — | `HARD_INVARIANT` | `STABLE_PRINCIPLE` |
| K65 | 停滞要区分规则错误、环境故障和真实市场条件 | D | skill.S07 / skill.S12 | — | `DIAGNOSTIC_HINT` | `VERSION_SENSITIVE_BUGS` |
| K66 | “路更空、队更短”必须排除出行丢失与需求崩塌 | A | skill.S07 / skill.S11 | — | `HARD_INVARIANT` | `STABLE_PRINCIPLE` |

## 8. Missing knowledge/spec gaps

Only gaps not supported strongly enough by the frozen source are listed here.

### 8.1 `MISSING_KNOWLEDGE_ASSET` — exact milestone / unlock optimization

The source establishes that plans must respect real unlock state and that land/asset/capability availability matters. It does **not** establish a high-confidence optimal development-point or milestone-unlock sequence across game versions/DLCs.

Frozen behavior:
- check whether a required asset/capability is unlocked;
- compare plans that are currently executable;
- do not fabricate an “optimal unlock tree.”

### 8.2 `MISSING_SPEC` — disaster response

“Disaster response” appears only as an optional specialist category. There is no sufficiently detailed raw knowledge pack defining triggers, observables, action families, success/failure conditions, or recovery policy.

### 8.3 `PARTIAL_SPEC` — large bridge/tunnel & major terrain reshaping

The source is sufficient for `skill.S17 BuildTerrainCrossing`:
- choose endpoints before middle;
- compare detour/grading/bridge/tunnel;
- treat a crossing as a regional project.

It is **not** sufficient for a general mega-project/major-terrain-remodeling specialist. Large-scale grading, complex interchanges, ports/ship-clearance, or multi-stage civil works remain `MISSING_SPEC`.

### 8.4 `MISSING_KNOWLEDGE_ASSET` — tourism / landmarks / signature-building optimization

The old source names this category but does not supply enough executable expert rules. The 2026 expansion cycle also introduces new visitor/tourism mechanics, making older assumptions especially unsafe. This domain must be separately researched if it becomes a product goal; it is not invented here.

### 8.5 `PARTIAL_SPEC` — advanced tax-based industrial steering

The source supports:
- taxes as a bounded economic/behavioral lever;
- no universal optimal tax rate;
- industry specialization should consider resource/logistics/pollution/labor.

It does not support a full autonomous “advanced tax industrial steering” specialist with validated product-by-product elasticities. Baseline behavior stays in `skill.S06` and `skill.S15`.

### 8.6 `MISSING_QUANTITATIVE_ASSET` — mail / telecom

The source supports the qualitative rule that mail/telecom can affect business efficiency and should not be treated as cosmetic only. It does not provide robust thresholds, capacity ratios or placement formulas. Therefore:
- include explicit mail/telecom penalties in service diagnosis when observable;
- do not create a dedicated autonomous optimization Skill;
- do not build from population thresholds.

### 8.7 `MISSING_QUANTITATIVE_ASSET` — transit mode thresholds

The source supports corridor-based comparison of bus/tram/metro/rail and rejects population thresholds. It does **not** support a universal passenger-count threshold at which one mode becomes optimal. Mode choice remains a feasibility/corridor comparison.

### 8.8 `NOT_A_GAMEPLAY_SKILL` — aesthetic detailing

Aesthetic detailing is a player preference/style layer, not a necessary expert-autonomy rule. It may constrain plans, but this Bible does not turn it into an executable optimization Skill.

### 8.9 `NOT_A_GAMEPLAY_SKILL` — player custom policy execution

“Execute player custom policy” belongs to intent/control-plane handling. It may parameterize the policies here, but it is not itself gameplay expertise and is not an autonomous Mayor Skill.

### 8.10 Deliberately unfrozen numeric constants

The following are **not gaps to fill by guessing**:
- universal road/intersection spacing;
- universal slope cutoff for all roads/assets;
- universal utility reserve percentage;
- universal service-per-population ratios;
- universal transit ridership thresholds;
- universal tax optimum;
- universal “open second district at N population” rule;
- fixed absorption/wait durations without version/map calibration.

These remain version/map/asset calibrated parameters under the frozen decision logic.

---

## 9. Production relevance matrix

`production_relevance` here means **gameplay importance by city phase**, not current implementation status.

### 9.1 Executable Skills

| Final Skill | production_relevance |
|---|---|
| skill.S01 SurveyDevelopmentSite | `EARLY_REQUIRED` |
| skill.S02 EstablishDistrictAccess | `EARLY_REQUIRED` |
| skill.S03 DeliverProductiveFrontage | `EARLY_REQUIRED` |
| skill.S04 ReleaseZoningTranche | `EARLY_REQUIRED` |
| skill.S05 CommissionUtilities | `EARLY_REQUIRED` |
| skill.S06 StabilizeFinance | `EARLY_REQUIRED` |
| skill.S07 DiagnoseGrowthBlockage | `EARLY_REQUIRED` |
| skill.S08 ObserveDevelopmentAbsorption | `EARLY_REQUIRED` |
| skill.S09 ProvisionEssentialServices | `EARLY_REQUIRED` |
| skill.S10 BalanceHousingJobsEducation | `MID_CITY_REQUIRED` |
| skill.S11 RepairTrafficBottleneck | `MID_CITY_REQUIRED` |
| skill.S12 RecoverDevelopmentProject | `EARLY_REQUIRED` |
| skill.S13 EstablishAndAdjustTransitService | `MID_CITY_REQUIRED` |
| skill.S14 ManageParkingWalkingCyclingAccess | `MID_CITY_REQUIRED` |
| skill.S15 ManageFreightIndustrialLogistics | `MID_CITY_REQUIRED` |
| skill.S16 RenewOrDensifyDistrict | `LARGE_CITY_REQUIRED` |
| skill.S17 BuildTerrainCrossing | `OPTIONAL_SPECIALIST` |

### 9.2 Domain policies

| Policy | production_relevance |
|---|---|
| POL-GROWTH Growth / Demand / Absorption | `EARLY_REQUIRED` |
| POL-ROAD Road / Access / Network | `EARLY_REQUIRED` |
| POL-ZONING Parcel / Zoning / Density | `EARLY_REQUIRED` |
| POL-UTILITY Electricity / Water / Sewage | `EARLY_REQUIRED` |
| POL-FINANCE Finance / Tax / Budget / Land Cost | `EARLY_REQUIRED` |
| POL-SERVICE Essential Services | `EARLY_REQUIRED` |
| POL-LABOR Housing / Jobs / Education | `MID_CITY_REQUIRED` |
| POL-TRAFFIC Traffic / Bottleneck Repair | `MID_CITY_REQUIRED` |
| POL-MOBILITY Parking / Walking / Cycling / Transit | `MID_CITY_REQUIRED` |
| POL-FREIGHT Industry / Freight / Supply Chain | `MID_CITY_REQUIRED` |
| POL-POLLUTION Pollution / Water Source Protection | `EARLY_REQUIRED` |
| POL-LAND Land Expansion / District Expansion / Unlocks | `MID_CITY_REQUIRED` |
| POL-RENEW Renewal / Demolition / Relocation | `LARGE_CITY_REQUIRED` |
| POL-RECOVERY Recovery / Abandon / Re-site | `EARLY_REQUIRED` |
| POL-LONGRUN Medium/Large Transition / Long-run Stability | `LARGE_CITY_REQUIRED` |

### 9.3 Reading the labels

- `EARLY_REQUIRED` — required for a credible repeatable early growth loop; may remain active forever.
- `MID_CITY_REQUIRED` — becomes necessary when multiple districts/capacity systems interact.
- `LARGE_CITY_REQUIRED` — required for sustained mature-city quality and renewal.
- `OPTIONAL_SPECIALIST` — required only on maps/goals that need the specialist behavior.

A label does **not** mean “implement this next.” It says when the gameplay capability becomes necessary for a high-level Mayor.

---

## 10. OLD_ASSET → FINAL_ASSET migration map

### 10.1 Original K01–K12 executable Skills

| Old asset | Final asset | Decision |
|---|---|---|
| K01 SurveyDevelopmentSite | `skill.S01 SurveyDevelopmentSite` | retained |
| K02 EstablishDistrictAccess | `skill.S02 EstablishDistrictAccess` | retained |
| K03 DeliverProductiveFrontage | `skill.S03 DeliverProductiveFrontage` | retained |
| K04 ReleaseZoningTranche | `skill.S04 ReleaseZoningTranche` | retained |
| K05 CommissionUtilities | `skill.S05 CommissionUtilities` | retained; gameplay spec updated from old implementation-status assumptions |
| K06 StabilizeFinance | `skill.S06 StabilizeFinance` | retained |
| K07 DiagnoseGrowthBlockage | `skill.S07 DiagnoseGrowthBlockage` | retained |
| K08 ObserveDevelopmentAbsorption | `skill.S08 ObserveDevelopmentAbsorption` | retained |
| K09 ProvisionEssentialServices | `skill.S09 ProvisionEssentialServices` | retained |
| K10 BalanceHousingJobsEducation | `skill.S10 BalanceHousingJobsEducation` | retained |
| K11 RepairTrafficBottleneck | `skill.S11 RepairTrafficBottleneck` | retained |
| K12 RecoverDevelopmentProject | `skill.S12 RecoverDevelopmentProject` | retained |

### 10.2 The 12 old “medium/large-city” names

| Old name | Final treatment | Reason |
|---|---|---|
| AcquireLandAndUnlockCapabilities | **split/absorbed**: land acquisition → `skill.S01` + `skill.S06` + `POL-LAND`; unlock optimization → `MISSING_KNOWLEDGE_ASSET` | land purchase has policy support; a full unlock strategy does not |
| DevelopAdditionalDistrict | **not a standalone Skill**; composed from P1–P8 + S01–S08 + `POL-LAND/POL-LONGRUN` | “develop another district” is a project composition, not a distinct bounded action |
| BuildPedestrianAndCycleConnections | → `skill.S14 ManageParkingWalkingCyclingAccess` | supported by K55–K56 and mobility policy |
| EstablishTransitService | → `skill.S13 EstablishAndAdjustTransitService` | supported by K57–K60 |
| AdjustTransitCapacity | **merged into S13** | capacity adjustment is part of operating the same transit service chain |
| DevelopCargoConnection | → `skill.S15 ManageFreightIndustrialLogistics` | supported by K61–K62 plus commercial/industry cards |
| ExpandIndustrialSupplyChain | **merged into S15** | same logistics/industry causal system; separate Skill would duplicate autonomy |
| UpgradeUtilityDistribution | **merged into S05 CommissionUtilities** | distribution is one branch of actual utility delivery, not a separate Mayor |
| RenewOrDensifyDistrict | → `skill.S16 RenewOrDensifyDistrict` | sufficiently supported by K15/K28/K52/K64 |
| BuildTerrainCrossing | → `skill.S17 BuildTerrainCrossing` | bounded bridge/tunnel/grading decision is sufficiently supported |
| ManageParkingAndAccess | **merged into S14** | parking is inseparable from walking/cycling/transit/destination access |
| ManageServiceDistrictAssignments | **merged into S09 ProvisionEssentialServices** | assignment is a service-fulfillment intervention, not an independent goal |

### 10.3 The 6 old specialist categories

| Old category | Final treatment |
|---|---|
| Disaster response | `MISSING_SPEC` |
| Large bridges/tunnels & terrain reshaping | bounded crossing covered by `skill.S17`; mega-project terrain/bridge specialist remains `MISSING_SPEC` |
| Tourism / landmarks / signature buildings | `MISSING_KNOWLEDGE_ASSET` |
| Advanced tax industrial steering | baseline principles absorbed into `skill.S06` + `skill.S15`; specialist optimizer remains `PARTIAL_SPEC` |
| Aesthetic detailing | `NOT_A_GAMEPLAY_SKILL`; player style constraint only |
| Player custom policy execution | `NOT_A_GAMEPLAY_SKILL`; intent/control-plane concern |

### 10.4 P1–P8 Planning Methods

All eight are retained as methods, not autonomous Skills:

| Old | Final |
|---|---|
| P1 Map decomposition | `plan.P1` retained |
| P2 Strategic region allocation | `plan.P2` retained |
| P3 District layout compilation | `plan.P3` retained |
| P4 Road corridor planning | `plan.P4` retained |
| P5 Block/parcel template fitting | `plan.P5` retained |
| P6 Project phasing | `plan.P6` retained |
| P7 Budget and capacity forecasting | `plan.P7` retained |
| P8 Feasibility comparison | `plan.P8` retained |

### 10.5 66 Knowledge Cards

- **0 cards become standalone Skills merely because they exist.**
- Every card is disposed exactly once in Section 7.
- Cards marked **A** became explicit policy rules.
- Cards marked **B** were merged to remove duplicate rules.
- Cards marked **C** remain heuristics/advisory knowledge.
- Cards marked **D** require version validation before becoming action predicates.
- Card **K53** is **E** because its general “temporary traffic must be proven before waiting” rule survives, while the older move-in/taxi symptom assumptions were partly superseded by 2026 changes.
- Card **K16** is **F** for gameplay purposes because unit/schema discipline belongs to implementation/data contracts rather than Mayor gameplay choice.

---

### 10.6 Final frozen Mayor behavior summary

A high-level autonomous Mayor should:

- choose sites by **complete deliverability**, not bare space;
- give every road and corridor a **declared purpose**;
- produce **real native connectivity** and **real productive frontage** before zoning;
- release R/C/I/O as **small capacity tranches** based on shortage and fit, not demand-bar chasing;
- prove **local utilities and service fulfillment**, not rely on global capacity or building presence;
- protect **cash runway** through the time when changes can produce results;
- diagnose **housing/jobs/education/business/service/traffic** chains before adding capacity;
- wait only in **bounded evidence-backed windows**;
- use traffic, parking, walking, cycling, transit and freight as **coupled access systems**;
- expand to new land/districts only when doing so solves a real constraint better than infill/densification;
- renew districts by **bringing replacement capacity live before removal**;
- recover with a bounded causal ladder and preserve failure history;
- transition from early → mid → large city behavior by **state and network complexity**, never a magic population threshold;
- stop safely when evidence is insufficient.

### 10.7 Freeze declaration

`AI_MAYOR_GAMEPLAY_POLICY_SKILL_BIBLE_FROZEN = TRUE`

This document is the final gameplay-policy asset baseline for AI Mayor V2.

It should be reopened only when one of the following occurs:

1. a game update changes a mechanic that materially invalidates a `HARD_INVARIANT` or `STRONG_POLICY`;
2. real long-run gameplay evidence demonstrates that a frozen rule repeatedly causes a wrong decision;
3. a currently missing specialist domain is deliberately added to product scope and researched with the same evidence discipline.

Current code implementation gaps are **not** a reason to rewrite or weaken this gameplay asset. They are an implementation-mapping problem for the next stage.

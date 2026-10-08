# K05 Skill Contract — 历史 contract 与当前生产实现对照（2026-09-29）

> 本文件只做对照与分类，**不写规则、不设计行为、不改代码**。等操作者裁决后再决定补什么。
> 依据材料：《AI Mayor V2 Skill Manifest（草稿）》（操作者提供，落盘于仓库根的 `新建 文本文档.txt`，28,272 字节），下文简称 **H**（历史 contract）。
> 依据实现：当前 repo 生产代码，下文简称 **P**（production）。
> 操作者已明确：**H 的旧 capability 状态不能覆盖当前 live evidence**；目标是恢复 Skill 的专家语义与职责，不是回滚已经成熟的执行基础设施。

---

## 1. 方法与免责

- 每一行结论都由代码检索取证（文件/符号计数见各条目），不靠记忆。
- H 自身声明：其字段取自附件原文，`current_product_mapping` 里的「可用/缺口」来自文档 T 项审计与 X- 能力缩写，属**「声明可用」，仍须接口验收**（H §1、§6 第 6 条）。因此 H 的能力状态是**有时效的声明**，不是当下事实。
- **本文件不裁决 H 与 P 的冲突**，只把冲突列出来（见 §5）。

---

## 2. 最重要的发现：生产 K05 manifest 与生产 K05 行为互相矛盾

`src/main/services/ai-mayor/skills/definitions/k05-commission-utilities.ts`：

```
name: "Commission Utilities"
description: "Plans a bounded utility commissioning sequence without executing construction."
capabilities: ["utility-planning"]
metadata: { execution: "planning-only" }
intent schema: { skillId: "skill.K05" }.strict()   // 无任何字段
```

- **P 的 K05 manifest 声称 planning-only、不执行施工**，且 intent 契约为**空**（只有 skillId，且 `.strict()`）。
- 但 `adapters/k05-commission-utilities-workflow.ts` 读 `intent.utilityKind` / `intent.strategyId`，Brain 派发的也是 `{skillId, utilityKind, capabilityId, strategyId}` —— 适配器用类型断言绕过 manifest 的 strict schema，**实际执行放置、连接、durable 提交与权威回读**。
- live 证据（本车间多轮）：`WindTurbine03` 放置、`Low-voltage Ground Cable` 提交、`OBSERVED_MATCH` 回读、exactly-once 与 UNKNOWN reconciliation 全部真实发生。

**结论**：P 的 manifest 是**过时的规划期描述**，已被当前代码**替代**；H 的 contract（K05 负责「让新增区域真正得到电水污水」、⑦逐个完成连接并验收）才与 live 行为一致。这条不是缺口，而是**契约文本落后于实现**。

---

## 3. K05 逐字段对照（H §4.5 / §5）

| H 字段 / 条目 | 分类 | P 的证据 |
|---|---|---|
| 规划设施用地 / 可用水源 / 既有网络节点 / 合格接入走廊选目标 | **已实现** | `spatial/utility-planner.ts` `planBootstrapUtilities`；`v2/greenfield-utility-bootstrap.ts`；`v2/utility-current-binding.ts`（既有设施绑定） |
| native preflight / 执行串行化 / 动作结果日志 | **已实现** | H §5.5 列的 v1 组件，全部在 P 中且被 K05 使用 |
| 电力：生产 | **已实现** | `capabilities.electricityProduction` / `windProduction`，`WindTurbine*` |
| 电力：线路 | **已实现** | `Low-voltage Ground Cable` 连接课程 |
| 电力：**进口** | **已观测、未执行** | `mayor_snapshot.utilities.electricity.import`；上一轮已把「outside-connection」显式标为 `UNSUPPORTED`（`v2/autonomous-brain.ts` `facilityGapOptions`）。H §5.2 的电力选项是「扩建/增设/重新连接」，**不含进口**，故此项不算缺口 |
| 电力：**变电（substation）** | **遗漏** | 全仓 `substation` 命中 **0** |
| 水：取水能力 | **已实现** | `freshWaterCapacity` / `groundWaterMaximum` / `allowedWaterTypes`（命中 9/9/7） |
| 水：**水质** | **已实现（仅作选点过滤）** | `groundWaterPollution` 命中 9；用法是 `=== 0` 过滤候选，**不是**持续水质观测 |
| 水：连通 | **已实现** | `serviceEvidence.networkConnected` / `targetNetworkReachable` |
| 水：**补给（replenish）** | **遗漏** | `replenish` 命中 **0**；H §5.2 明说「水深无法替代水流/污染/补给」 |
| 污水：排放 | **已实现** | `SewageOutlet*` + 岸线选点 |
| 污水：处理能力 | **已实现** | `sewageCapacity` / `sewagePurification` |
| 污水：**环境风险 / 污染不会到达取水口** | **遗漏** | `flowDirection` / `pollutionTransport` 命中 **0**。P 会按「owned + 干燥 + 坡度 + 临水」选排污点，**没有任何水流/污染输送推理**。H §5.2 明确：「无水流数据则不能证明『污染不会到达取水口』」——即正确行为是不声称安全 |
| ⑤比较扩建/增设/重新连接，不默认新建设施 | **已实现（上一轮补齐）** | `facilityGapOptions` 的 tier 比较 + `deriveUtilityGap` 的 `existingUsableCapacity` 短路；策略阶梯含 `REUSE_REACHABLE_NETWORK` / `RECONNECT_TARGET` / `EXTEND_EXISTING_NETWORK` / `REPAIR_MISSING_FLOW_PATH` / `FACILITY_REPLACEMENT_LAST_RESORT` |
| ⑥形成**至多 3 个**完整服务方案 | **数字不符，需裁决** | P 用 `MAX_WATER_PLANNING_CANDIDATES = 8` 与 `candidateFacilities` 排序列表；未见「3」这一上限 |
| ⑦逐个完成连接并验收 | **已实现** | durable command → native → `OBSERVED_MATCH`；`reconciliationRequired` 处理未决 |
| ⑧验收目标区域实际供给＋本期已承诺负载余量 | **部分实现** | P 有 `cityCapacityAvailable`（全市）与 Gate1 的 per-building consumer 回读；H §5.3 明确「全市供需条为正不够」，P 的**禁止推断**这一条是否被显式执行需逐点核对 |
| 失败分支：容量不足/断连/污染/缺员工/燃料不足 | **部分实现** | 前两者有；污染、缺员工、燃料**无对应观测**（T20/T21/T22 缺） |
| **BLOCKED_TELEMETRY** 终态 | **遗漏** | `BLOCKED_TELEMETRY` 命中 **0**（同理 `BLOCKED_SITE` / `BLOCKED_CAPABILITY` 也是 0）。P 的现存词汇是 `UNKNOWN` / `lastFailureBoundary` / `reconciliationStatus` / `PLANNING_HANDOFF` / `BRAIN_STRATEGIES_EXHAUSTED` |
| 指标集：到户服务率/未供应量/余量/有效产出/设施利用率/实际完整费用 | **部分实现** | 余量（`cityCapacityAvailable`）与费用（`minimumFeasibleUtilityBudget`）有；到户服务率/未供应量/有效产出/设施利用率**无** |
| X-U 中的**升级** | **遗漏** | 全仓 `upgrade` 命中 12 处但**全部是 `upgrade_road`**（道路照明等），**没有 utility 设施升级动作** |
| H §5.4 知识卡 E4-K35…K42 | **多数遗漏** | `fuelInventory` / `WaterTower` 等命中 0；局部断电、变电负载、线路流量、水流速、污染场、储层、固废均无观测 |

---

## 4. K01–K12 家族层面（H §3 / §4）

生产 `skills/definitions/` 下**只有 K05**：全仓 `skill.K\d+` 唯一命中是 `skill.K05`。

| H 技能 | 家族分类 | P 的对应机制 |
|---|---|---|
| K01 SurveyDevelopmentSite | 能力存在、Skill 身份缺失 | `spatial/world-scanner.ts`、`v2/site-selection.ts`、admission 的候选/半径搜索 |
| K02 EstablishDistrictAccess | 能力存在、Skill 身份缺失 | Gate1 `ROAD_CONNECTION` 任务 + road kernel |
| K03 DeliverProductiveFrontage | 能力存在、Skill 身份缺失 | frontage 评分 + GRID 家族 |
| K04 ReleaseZoningTranche | 能力存在、Skill 身份缺失 | Gate1 `ZONING` 任务 + 上一轮的 `isAbsorbing` |
| **K05 CommissionUtilities** | **已注册的 Skill** | `skills/definitions/k05-*` + 适配器 + greenfield bootstrap |
| K06 StabilizeFinance | 部分（只读） | 财库/月结可读；X-E 干预无 |
| K07 DiagnoseGrowthBlockage | 部分 | Gate1 `OCCUPANCY_DIAGNOSIS`（`ACCESS_FAILURE`/`UTILITY_FAILURE`/`ZONING_OR_DEMAND_DELAY`） |
| K08 ObserveDevelopmentAbsorption | 部分 | 有界 wait 循环 + `WAIT_OBSERVE`；**无** H 要求的「最短/正常/绝对最大窗口」三段计时器 |
| K09 ProvisionEssentialServices | 遗漏 | 只有 utilities 三类；healthcare/education/garbage/fire 是**只读观测**（上一轮已确认并写死为不可 actionable） |
| K10 BalanceHousingJobsEducation | 遗漏 | 无教育/岗位分层观测（T12–T14 缺） |
| K11 RepairTrafficBottleneck | 遗漏 | 无交通观测（T23/T24 缺）、无 X-T |
| K12 RecoverDevelopmentProject | 部分 | durable reconciliation / UNKNOWN 处理存在；H 要求的 SAFE_PAUSED 与换址预算语义未见 |

---

## 5. 必须由操作者裁决的冲突（我不自行裁决）

1. **K05 的范围**：P manifest 写 `planning-only / without executing construction`，而 H 与 live 行为都是「commission（执行并验收）」。契约文本要不要改成与实现一致？
2. **H §5.6「认证一个 recipe family（非多方案 utility planner）」** 与 P 现有的 `planBootstrapUtilities` 多家族 + 策略阶梯直接冲突。这是「历史边界」还是「已成熟的执行基础设施」？
3. **「至多 3 个完整服务方案」** 是否为硬上限（P 现为 8 候选）。
4. **BLOCKED_TELEMETRY / BLOCKED_SITE / BLOCKED_CAPABILITY**：H 命名了 `BLOCKED_TELEMETRY`，上一轮任务命名了后两者，**P 三者都没有**。终态词汇是否需要建立，以及建立哪些。
5. **污水环境风险**：在没有任何水流/污染观测的前提下，正确行为是「据实 BLOCKED_TELEMETRY」还是「用已验证的保守 recipe」（H §5.6 允许后者）——这决定要不要继续动 sewage，以及动哪一侧。

---

## 6. 本轮明确不做

- 不自行推断、重建或扩写 K05 的专家语义。
- 不新增 planner / Brain / policy / 第二套 utility architecture。
- 不为了让 live 通过做替代设计。
- 不回滚已经过 live 验证的执行基础设施（native preflight、durable、exactly-once、authoritative readback、UNKNOWN reconciliation）。

## 7. 本轮保留的既有改动（非设计推断，是缺失的生产调用）

- `createWaterSiteConstraint` 支持 `utilityKind?: "water" | "sewage"`，`siteConstraintForGoal` 同时匹配两类（此前 sewage 命中 `null`，**完全没有任何设施可放置性闸门**）。
- site-scope escape 从 water 推广到两类（`MAXIMUM_UTILITY_GOAL_SITE_SCOPES` / `utilityGoalSiteScopes` / `nextUtilityGoalSiteScopeId` / `UTILITY_SITE_SCOPE_PREFIX` / `openNextUtilityGoalSiteScope`）。
- 依据：这是**被漏掉的调用**，不是被遗漏的专家规则。144/144 测试通过。

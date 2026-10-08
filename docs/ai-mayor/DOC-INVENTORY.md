# docs/ai-mayor 文档清单与状态（2026-10-02）

> 状态口径：**有效** = 现在仍为真；**部分过期** = 有仍成立的章节，也有已作废的结论（逐条列出）；
> **作废** = 整篇被取代，顶部已加"已过期，见 HANDOFF-CODEX.md"。
> 入口见 `HANDOFF-CODEX.md`。`evidence/` 下 424 个文件是**历史实测原始记录**，只作证据不回改。

## A. 有效

| 文件 | 行数 | 说明 |
|---|---|---|
| `HANDOFF-CODEX.md` | 119 | **交接入口**，取代此前所有 HANDOFF |
| `DOC-INVENTORY.md` | 本文件 | 清单本身 |
| `PRODUCT_NORTH_STAR.md` | 204 | 产品目标，用户原话来源 |
| `V2_ARCHITECTURE_BASELINE.md` | 78 | 自述 "CURRENT ARCHITECTURE AUTHORITY" |
| `HANDOFF-2026-10-02-E.md` | 43 | 最近一轮完整交接（Load 死锁修复 + 退休路径删除 + 真实 Load 验收） |

## B. 部分过期（列出过期章节）

| 文件 | 行数 | 仍成立 | **已作废章节** |
|---|---|---|---|
| `UTILITY-SITING-CONSTRAINTS.md` | 80 | §1 判服务读 `consumerService.water.*`；§2 一街一设施（**强经验规律，非图不变量**）；§4 入口表；§8a-0 `sewageConnected` 在 `water` 之下；§10 里程碑弹窗暂停游戏 | **§3 水源=groundWater（旧世界东群）** · **§7 沿街铺管抬覆盖**（旧世界稀疏网；本世界实测铺缆 48%→13%） · **§8 的 600 m reach 规则与五条距离实测**（旧世界 generation `1e53914edf…`） · **§8 "排污口必须临水/本区 600 m 内无水体"**（旧世界推得、**未复证**；本世界新区 20 m 外就有排污口） · **§8b/§9 的 40 m 街区结论**（旧世界） |
| `HANDOFF-2026-10-02-C.md` | 96 | §1 一条街=一次提交；§2 折回射线判据 + 两端自由；§3 `planRectangularGrid` 改动；§5.2 换节点对才有解 | **§5.3 的 13 栋建筑与 offset 读数** · **§5.4 的 569/1145/1465 距离表与"600 m 内每网须有设施"** · **§5.5 排污口只能临水/本区无水体** · **§5.6 电 19/21 等旧世界读数** · **§5.7 铺 47 条管的拓扑**（旧世界） · **§9 的调用方盘点**（本轮已接 `scopeNeedsService`） |
| `HANDOFF-2026-10-02-D.md` | 83 | §1 集合格网接线；§1.2 zoning epsilon 修复；§3 durable 裁决与 6 条盘点 | **§2 的 live 证据数字**（旧世界） · **§3 的"第二层诊断"与 `goalWorkOrders` 涨到 163 的解释**（真实成因是 plan 未随 projectState 退休，见 E §1） · **§4 的 61 例测试债**（已全绿） |
| `REMOVABLE-DURABLE-GATES-2026-10-02.md` | 57 | 6 条清单本身；第 3 条（**市长不擅自存玩家的城**）未摘、仍是承诺 | **§1/§6 的"待裁决"状态**：第 1 条与第 6 条的 authority 部分**已实施并删除代码**；§2/§5 尚未动 |
| `INVESTIGATION-2026-10-01-road-course-and-facts-churn.md` | 592 | 道路认证稀疏性、Goal 身份 churn、17 块自绊——**均为道路结论**，与 utility 无关 | 无（其结论未受本轮影响） |
| `TECHNICAL_MAP.md` | 583 | 仓库结构事实 | 会随代码漂移的入口/行号 |
| `CAPABILITY-GAP-2026-10-02.md` | 54 | 能力缺口分类 | "未接线"清单：集合格网/同一分量验收/`scopeNeedsService` 本轮已接 |
| `EXPANSION-PACKAGE-MINIMAL-SLICE.md` | 43 | 切片目标（一片=路+管线+zoning 同批交付） | 其中的选址/可达假设沿用旧世界 |
| `K05_SKILL_CONTRACT_GAP_ANALYSIS.md` | 69 | contract 对照 | 生产实现已演进 |
| `AI_MAYOR_GAMEPLAY_POLICY_SKILL_BIBLE_FROZEN.md` | 700 | 玩法政策与 skill 圣经（2026-09-30 冻结） | 其中的实测数字 |
| `URBAN_DESIGN_LANGUAGE.md` | 471 | 城市设计语言（ALPHA 冻结） | — |
| `DIRECT_GROWABLE_PLACEMENT_CAPABILITY.md` | 76 | `NOT_SUPPORTED` 裁决 | — |
| `CONTROL_PLANE_SOURCE_PACKET.md` | 274 | 只读源码摘录（参考） | 行号 |
| `CLAUDE_GATE1_ADMISSION_PACKET.md` | 1122 | 只读代码审阅包 | 行号 |
| `ROAD_EXECUTION_CONTRACT_PACKET.md` | 116 | 道路执行契约源码包 | 行号 |
| `V2_UTILITY_CONNECTION_STATE_CONTRACT.md` | 327 | utility 连接状态契约（提案态） | — |
| `UDL_PHASE6_REALIZATION_AUDIT.md` | 115 | 架构审计基线 | 作废见下（已加标记） |

## C. 作废（顶部已加"已过期，见 HANDOFF-CODEX.md"）

| 文件 | 行数 | 作废理由 |
|---|---|---|
| `CURRENT_STATUS.md` | 1862 | 停在 2026-09-26，V2 早期状态 |
| `IMPLEMENTATION_STATUS.md` | 2313 | 停在 2026-09-30 |
| `NEXT_SESSION.md` | 2734 | 停在 2026-10-01 |
| `ARCHITECTURE.md` | 43 | 自述 LEGACY（v1 Core MVP） |
| `LOCAL_MAYOR_ENGINE.md` | 96 | 自述 LEGACY（v1） |
| `LOCAL_MAYOR_GROWTH_STALL_AUDIT.md` | 164 | 自述 LEGACY（v1） |
| `LOCAL_MAYOR_CANONICAL_FRONTAGE_LIVE.md` | 8 | 自述 LEGACY（v1） |
| `ALPHA_HARDENING.md` | 19 | Alpha Core 已冻结并整体换代 |
| `CITY_ISSUE_AWARENESS.md` | 20 | Local Mayor v0 |
| `PRODUCT_SPEC.md` | 50 | Core MVP（v1）规格 |
| `AI市长V2_当前状态（最新）.md` | 104 | 中间状态卡，已被 HANDOFF 链取代 |
| `AI市长V2_当前状态.md` | 104 | 同上 |
| `AI市长V2_接班卡归档_20260917.md` | 104 | 归档 |
| `AI市长V2_路线裁决与历史档案.md` | 377 | 历史档案 |
| `HANDOFF-2026-10-02.md` | 49 | 被 B 取代 |
| `HANDOFF-2026-10-02-B.md` | 40 | 被 C 取代 |
| `UDL_PHASE6_REALIZATION_AUDIT.md` | 115 | 2026-09-11 审计 |
| `UDL_ROAD_CANDIDATE_REJECTION_AUDIT.md` | 48 | 2026-09-11 审计 |

## D. 含过期结论的章节速查（按主题）

| 过期结论 | 出现在 | 现状 |
|---|---|---|
| **600 m reach（欧氏）** | `UTILITY-SITING-CONSTRAINTS.md §8` · `HANDOFF-C.md §5.4/§9` | **本世界实测反例**：325 m ⇒ 0%；50 m ⇒ 48%。电的判据待定（HANDOFF-CODEX §5.1） |
| **"同分量即服务"** | `UTILITY-SITING-CONSTRAINTS.md §7`（已在 §8 自我修订） · `HANDOFF-C.md §5.4` | 已被 §8 推翻且本轮再确认（同分量、325 m、0%） |
| **"排污口必须临水" / "本区 600 m 内无水体"** | `UTILITY-SITING-CONSTRAINTS.md §8/§8a` · `HANDOFF-C.md §5.5` | 旧世界推得、**未复证**；本世界新区 20 m 外即有 `SewageOutlet01`，且补放后污 94% |
| **"沿街铺管抬覆盖"** | `UTILITY-SITING-CONSTRAINTS.md §7` | 本世界铺**缆**反而 48%→13% |
| **旧世界距离表（569/680、611/1145、1021/1323、1028/1631、1389/1465）** | `HANDOFF-C.md §5.4` · `UTILITY-SITING-CONSTRAINTS.md §8` | 全部属于 generation `1e53914edf…`，本世界作废 |
| **"600 m 内每网须有设施"** | `HANDOFF-C.md §5.4` 末 | 水/污仍成立；**电不成立** |

## E. 本清单此前**完全未收录**的仓库根文档（2026-09-12 ~ 09-29）

这批文件在仓库根（不在 `docs/ai-mayor/`），**没有任何一份带"已过期"标记**，也**从未出现在本节 A/B/C 三表或
`HANDOFF-CODEX.md` 的必读/按需/禁读里**。整体日期早于 2026-10-02 的重组。逐份状态**未经本体系裁定**。

| 文件 | 行数 | 性质 | 备注 |
|---|---|---|---|
| `AI_MAYOR_V2_CONTROL_PLANE_MIGRATION_BLUEPRINT.md` | 562 | 迁移蓝图（设计，无实现代码）；§25 = 2026-09-29 | ⚠️ 主张新增 `DecisionAuthority`/`DecisionToken`/`ExecutionContextAdapter`，**与 `HANDOFF-CODEX.md §6 铁律直接对撞** |
| `AI_MAYOR_GAMEPLAY_POLICY_SKILL_BIBLE_FROZEN.md` | — | 见 B 表（在 `docs/ai-mayor/` 下有同名副本） | — |
| `AI_MAYOR_PRODUCT_NORTH_STAR.md` | 141 | 北极星 supplement | 自认权威入口是 `docs/ai-mayor/PRODUCT_NORTH_STAR.md` |
| `AI_MAYOR_VOICE_BIBLE_V1.md` | 241 | 产品语言人格设计 | 无对应 |
| `AI_MAYOR_DOCUMENT_MAP.md` | 144 | 旧文档索引，2026-09-22 | ⚠️ 指向 `IMPLEMENTATION_STATUS.md`/`NEXT_SESSION.md` 为"当前入口"，**与本清单 §C 结论相反** |
| `AI_MAYOR_HANDOFF.md` | 47 | 旧交接入口 | ⚠️ 描述的世界与主线**与本清单不同**（见 `HANDOFF-CODEX.md §7`） |
| `AI_MAYOR_SYSTEM_INVENTORY.md` | 252 | 系统盘点 | 以已删除机制为现状 |
| `AI_MAYOR_REPOSITORY_AUDIT.md` | 155 | 仓库审计 | 同上 |
| `AI_MAYOR_RECOVERY_REPORT.md` | 130 | 恢复报告，HEAD date 2026-09-12 | 同上 |

**未裁决**：这批该被认领、还是该被标废——本清单不下结论，只记录"它们存在且与 A/B/C 三表不连通"。

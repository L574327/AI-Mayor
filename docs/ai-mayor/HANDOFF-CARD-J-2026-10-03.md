# 交接卡：J（跨区域迁移 / 停死）+ 城市不长人 — 2026-10-03

**范围**：用户授权大刀阔斧；本卡只记事实与证据，可复跑。世界 = 斯奈德维尔 `ff472a1098e24131b052079ecbea57a2`（换档即作废）。

## 一、已修的缺陷（每个都先测量、后修复、有测试；测试均验证"无修复会失败"）

| # | 症状（实测） | 根因 | 修法 |
|---|---|---|---|
| 1 | 7/7 tick 空转：`liveness invariant violated: ROAD_DELIVERED has no executable task` | 顶层项目 ACTIVE 停在里程碑、work order 已完成，增长策略不被询问 | `runtime.ts` `orphanedProject` |
| 2 | `ESTABLISH_ROAD_NETWORK` 860/860 候选被 `TARGET_NOT_ADVANCED` 拒 | 独立路网 Goal 的"目标"只是**网格参照点**（上条路终点/最早路起点），却被要求"每步更靠近它" | `site-selection.ts` `dropReachedTarget` + `targetIsReferenceOnly`（准入与 Gate 1 回放一致） |
| 3 | `PROVIDE_SERVICE:electricity` 同节点反复死 | `goalOrderUnservableRoadTarget` 正则只认 EXPAND_* | 正则加入服务族 |
| 4 | 失败原因被截断看不出 | 直方图全零 + 240 字符截断 | 只输出非零项；policy answer 带 detail；road 步骤失败带 `offered=`/`anchor=`/`buildings=` |
| 5 | 20 tick 连续被 `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` 拒 | 格网"接入路"第二段**压在既有街道上**（z≈505.8），只有集合街线做了沿路检查，接入段没有；准入只拒 INVALID，放行了它 | `road-grid-generator.ts`：接入段同样判沿路 |
| 6 | 世界里多出一条 44 m 孤立断头路（第 4 个分量） | 接入段第一段被过滤后，第二段（起点在肘点，不在任何街上）被单独建成 | 接入路 **要么整套腿都过、要么都不提供** |
| 7 | 准入有 1 条候选、Gate 1 回放格网为 0 条 | 候选数取决于锚点 detail 窗口里"已知建筑"；回放重算与准入不一致 | 回放重算为空时沿用站点自带候选 |
| — | `FORCED_SAVE_ON_STOP` | `#finalize` 无条件 `save()` | 已删（用户裁决） |
| — | A 层 | 本地意图是封闭枚举，region 非 ANY 被静默丢弃 | `v2/intent-primitive-map.ts` 查表，缺口按名拒绝 |
| — | J 前沿测绘 | 搜索只围着路网节点，看不到"没路到达的空地" | `v2/frontier-discovery.ts`（平地补丁测绘）+ 准入在"无站点"时走走廊前置；**live 尚未被触发过** |

## 二、世界读回（`scripts/tmp-component-census.ts`，只读）

| | 交接时 | 现在 |
|---|---|---|
| 总街数 | 479 | **495** |
| 东群岛 | 103 街 | **113 街** |
| 主城 | 375 街（未被动过） | **380 街**（产品首次触及） |
| 分量 | 3 | 4（含 1 条 44 m 孤路，已修生成逻辑，**这条旧孤路仍在**） |

12 tick 实测：约一半 tick 有真实建设，session 全程 `RUNNING` 无错。修复前 40 tick 仅 3 次动作。

## 三、新发现：**城市不长人，不是缺路缺区，是缺"城市服务"**（只读实测）

- 人口 2026-01 的 47 → 一年后（2027-01-02）**45**；国库 603k → 577k（月亏约 5.9 万）。
- 建筑 166：工业 **81**、商业 21、住宅 38；岗位 808 个、**812 个空缺**，就业仅 23；住宅需求为正（householdDemand 67）。
- **账本 `serviceBuildings=0`**：没有任何学校/诊所/消防/警察/垃圾场；垃圾累积率 8096；通知 152 条（缺水 24、缺电 10、缺污水 8、废弃倒塌 8、缺教育劳力 86）。
- 水电污**到位率不是问题**：逐栋读回全城 电 93% / 水 80% / 污 92%（口径=有 consumer 组件的建筑）。
  但 `electricity fulfilledConsumption/consumption` 恒 **38–39%**（产能是需求 2 倍）——两个口径冲突，**未解**。
- 自有地只有 **9/529 块**；已建区域 8492 格仅剩 **114 空闲 / 37 临街**；另有 3 块自有地（(623,0) (623,-623) (1247,-623)）**平坦、无水、完全空白**（≈1.16 km²），目前没有路到达。
- 桥侧已解锁可放：`FireHouse01/02` `PoliceStation01-03` `MedicalClinic01/02` `ElementarySchool01/03` `HighSchool01-03` `Landfill01`。

**假设（未证实）**：零服务建筑 ⇒ 吸引力/幸福度低 ⇒ 一年零净增长。验证最便宜的办法是**玩家在游戏里手放 2–3 栋服务建筑后看人口**。

## 四、停在这里的原因（需要用户裁决）

产品放置建筑被硬限在 `actionFamily:"UTILITY"`（`main-adapter.ts:129-143`、`durability.ts:1338`）。让产品能放**公共服务建筑**要新增一个持久化 action family（或扩 `GreenfieldUtilityKind`），**必然触碰 durability / 授权 scope 类型**——这是你设的停止条件。

## 五、其他未成立项
- 前沿测绘 + 走廊前置（跨区域迁移）**代码已落、有单测，live 尚未触发**：独立路网 Goal 现在总能在节点附近找到小站点，不会走到"无站点"分支。
- 电 `fulfilled` 39% 与逐栋 93% 的矛盾（可能是风机未接入、或口径不同）未定位。
- 旧孤路 `56029:191`、`236313:157` 仍在世界里（产品没有拆除原语）。
- 游戏被 harness 结束后会留在 4 倍速运行；再跑前先 `npx tsx tmp/pause-world.ts`。

## 六、复跑
`npx tsx tmp/pause-world.ts` → `AI_MAYOR_LIVE_TICKS=12 AI_MAYOR_CONTINUOUS_EVIDENCE=tmp/x.json npx tsx scripts/ai-mayor-continuous-growth-live.ts *> tmp\x.log`；只读探针：`tmp/probe-world-readonly.ts` `tmp/free-land-census.ts` `tmp/probe-city-health.ts` `tmp/probe-immigration.ts` `tmp/probe-service-prefabs.ts`。**同一时刻只能一个桥读写方。**

## 七、三假设排查结论（2026-10-03，只读实测 → 修复 → live 复验）

- **H1 缺电：否。** 城市级满足率 39% 是口径：3 座抽水站占全城用电 91%（其中 2 座从未接线），住宅 172/172、商业 99/99、工业 629/637 实际满足。修：产能充足时不判 critical，记 `undeliveredLoad`。
- **H2 住宅不足：是，主因。** 产品只划 `EU Residential Low`（游戏低密度需求 0、中/高 100）；快照 zone 目录被截到 12 条且无 spawnable 字段，看不到 `EU Residential Medium`；工业缺工人（`UneducatedWorkforce -180`）仍被立项 57 次 vs 住宅 11 次。修：按密度需求选 zone、补全目录、缺工人的岗位域让位住宅。
- **H3 缺公共服务：未证为主因**（犯罪率 96、教育计数 8、无服务建筑），civic family 并行落地。
- **H0 仿真时间（新增）**：此前所有长跑合计仅约 2 个游戏日（约 1 游戏日 / 墙钟小时），"一年不涨"是日历误读。
- **复验（tmp/run-h2b-10tick.json）**：10 tick 中 9 tick 建设，中密度住宅 ×5；**人口 44 → 101–103，户数 23 → 61，住宅建筑 38 → 55**。

## 八、截止 2026-10-03 23:58 的状态

- 已提交 `189f87d`：civic family（`utilityKind:'civic'`，复用 UTILITY 记账与读回，未改 Apply-once/readback matcher）；被拒的路网站点作为排除区，避免同站点反复死（MVP1 在 `55896:1` 连续 26 tick 停死）。
- **MVP2 验收长跑正在后台运行**（45 tick，证据 `tmp/run-mvp2.json`，日志 `tmp/run-mvp2.log`），结果未读。
- 未完成：civic 执行器的端到端单测（夹具参考 `test/ai-mayor/v2-command-never-submitted.spec.ts`）；civic 在 live 中尚未放置成功过；跨区域迁移 live 未观测；仿真时间仅约 1 游戏日/墙钟小时。
- 注意：停 MVP1 时我按命令行结束了所有 `mcp-server` node 进程，若有别的客户端在用 cs2 MCP 需重连。

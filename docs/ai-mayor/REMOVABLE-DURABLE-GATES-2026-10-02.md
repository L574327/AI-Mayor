# 可摘除的 durable 关卡清单（2026-10-02）

> **前提（用户原则）**：游戏世界是唯一权威。流程 = 读世界 → 照常扩张。
> 游戏自带防呆（overlap / 节点占用 / 409）**就是**重复建设的保护，不再另设对账层。
> 回滚 = 玩家 Load 旧档，产品**重读世界**继续；**不再要求账本与存档配对**。
>
> 本清单**只列，不改**。公共不变量的改动由用户裁决。
> 每一项给出：file:line · 摘除后是否仍有"读世界"的替代 · 风险。

---

> **状态更新（2026-10-02 深夜，见 `HANDOFF-2026-10-02-D.md` §3）**
>
> 用户已裁决：**玩家 Load 后以当前世界为权威重新建立执行基线，不要求历史 durable 与存档逐条配对。**
> 并把 6 条作为**同一个 Load/回滚语义**整体审视，而非逐关打补丁。
>
> 整体审下来**只有第 1 条（血缘确认）在行使"历史否决当前世界"的权力**；2/5 是要用的机制，
> 3 是对玩家的承诺（Load 场景走不到，**未摘**），4 是本会话内正确性，6 要拆（退休 authority、留预算语义）。
>
> **已实现**：`durability.ts` 的 `activate()` 把"证不了的 descendant"从 quarantine 改成 **re-baseline**
> （退休 `projectAuthority`/计划，cut 取当前 journal 位置，交给既有 `DESCENDANT_CHECKPOINT_REQUIRED` 采纳加载档）。
> **未触及**低层正确性（授权 / Apply-once / readback）。**本清单其余各条仍待裁决。**

---

## 1. 血缘确认（descendant confirmation）

| | |
|---|---|
| **file:line** | `v2/durability.ts:1968`（`confirmDescendantSaveReload`）· `:3971,4027`（`DESCENDANT_CONFIRMATION_REQUIRED` 状态机）· `:84,92`（kind/status 枚举）· 驱动处 `v2/main-adapter.ts:2851,2880` |
| **它现在拦什么** | 世代变化后（`DESCENDANT_SAVE_RELOAD`，`durability.ts:3816`）要求"确认这是同一个世界的后代"，否则整条 lineage 保持 quarantine，一切 durable 写入被封 |
| **摘除后的读世界替代** | **有，且已经存在**：`observations` / `consumerService` / `cs2_list_roads` 都能直接读世界。产品要判断"这栋楼/这条路/这条管在不在"，读世界即可，不需要"血缘确认"这个中间人 |
| **风险** | 中。摘除后产品在**新世代**里会对既有目标重新下命令；游戏会用 overlap/409 拒绝**已存在**的，产品记录并继续（这正是你要的幂等）。真正风险是**同一目标的重复服务**（例如同一街区再铺一遍 `Small Sewage Pipe` 被拒后记成"缺口"），需靠"先读已有→已有则跳过"补上，而不是靠血缘 |

## 2. checkpoint 绑定（`ensureDurableWorldOnce`）

| | |
|---|---|
| **file:line** | `v2/main-adapter.ts:2847`（`ensureDurableWorldOnce`）· `:2915`（`DESCENDANT_CHECKPOINT_REQUIRED` 分支）· `:2932`（`findLoadedWorldSave` / `findAvailableWorldSave`）· `:2726`（`findLoadedWorldSave` 实现）· `durability.ts:2080,2100`（`:2100` 硬要求 `baseline?.status === "DESCENDANT_CHECKPOINT_REQUIRED"`） |
| **它现在拦什么** | 一次 durable 写入必须绑定到一个**存档**；`isLoadedSave` 只在"从存档加载"时置位（已实测），所以玩家在游戏内存档后**依然**会被判成没有可绑定存档 |
| **摘除后的读世界替代** | **有**：`cs2_game_state` 的 `worldId`/`generation` 足以做"当前世界"的身份；不需要"哪个存档" |
| **风险** | 低-中。摘除后失去的是"这条命令是在哪个存档的世界上提交的"这一条溯源；对"读世界→扩张"的流程**无用**。风险是调试时难以回答"这条命令属于哪次世界"，但这属于可观测性，不是正确性 |

## 3. `DESCENDANT_USER_SAVE_REQUIRED`（产品不许自己存档）

| | |
|---|---|
| **file:line** | `v2/main-adapter.ts:2942` |
| **它现在拦什么** | 没有可用存档且 `automaticRecoverySave !== true` 时，**拒绝** durable 恢复并返回"请玩家存档后重跑" |
| **摘除后的读世界替代** | 它本来就**没有**读世界的替代——它是一条**策略**（"存档是玩家的决定"），不是观测 |
| **风险** | 低（若采纳新原则）。新原则下"回滚=玩家 Load 旧档"，本来就不要求产品维持存档配对 ⇒ 这条可直接作废。**但它是产品对玩家的一个承诺**（"不擅自存你的城"），摘除等于改变那个承诺，需你明确 |

## 4. 回滚对账 / effect-absence（"证明缺失"）

| | |
|---|---|
| **file:line** | `v2/road-effect.ts`（`effectAbsenceProven` 的产生处）· `v2/utility-network-laying.ts:204-215`（net 侧的 `MISMATCH + effectAbsenceProven`）· `v2/gate1-progression-boundary.ts`（边界消费该判决）· `v2/foundation.ts`（枚举） |
| **它现在拦什么** | 命令提交后若"完整列举里没有该效果"，判定为**缺失**并作为**回滚决策的输入** |
| **摘除后的读世界替代** | **有，且更强**：直接读世界（`cs2_list_roads` / `/city/buildings` / `consumerService`）就能回答"在不在"，不需要"权威列举 + 完整性契约"这一整套 |
| **风险** | **中-高**。已经实测过一次**假缺失**：管道不在 road graph 里，REAL 存在的管被判 `MISMATCH + effectAbsenceProven`（与"同 prefab 在空地"裁决完全相同）。**假缺失会驱动回滚，方向最危险**。摘除它反而消除这个风险面；但"读世界"的读法必须选对（见 `UTILITY-SITING-CONSTRAINTS.md`：pipe 走 `cs2_list_roads`，服务走 `consumerService`） |

## 5. 回滚锚点 / checkpoint 之外的命令判定

| | |
|---|---|
| **file:line** | 账本 `active.certifiedRollbackAnchor` · `active.rollbackBoundaryId` · `active.loadedCheckpointId`；判定 `v2/main-adapter.ts:2896`（`isCommandOutsideActiveCheckpoint`）· `v2/durability.ts`（`isExecutionDurablyActivated` 等） |
| **它现在拦什么** | 决定哪些命令"在 checkpoint 之外"，从而在回滚时被丢弃 |
| **摘除后的读世界替代** | **有**：新原则下"回滚=玩家 Load 旧档"，世界**已经**被游戏回退了，产品**重读世界**自然看到回退后的样子，不需要账本再算一遍"哪些命令该丢" |
| **风险** | 低，但**它是最大的净删面积**：`rollbackBoundaryId`/`certifiedRollbackAnchor`/`isCommandOutsideActiveCheckpoint` 这条链牵动 journal 与 gate1 的多个判定。摘除前应先把"读世界"的判据固定下来（谁是权威读数、pipe 走哪条路），否则会用一个不确定的读数替掉一个确定的判定 |

## 6. 基线激活 / 执行分支（`BASELINE_CHECKPOINT_REQUIRED`、`executionBranch`、`projectAuthority`）

| | |
|---|---|
| **file:line** | `v2/durability.ts:1184`（状态白名单）· 账本 `active.baselineActivation` / `executionBranch` / `projectAuthority` / `descendantConfirmation` |
| **它现在拦什么** | 首次激活要求一个基线存档；执行发生在某个 branch / project authority 之下 |
| **摘除后的读世界替代** | **有**（对"读世界→扩张"而言）：`cs2_game_state` + 扫描就是全部输入 |
| **风险** | 中。这些字段同时承载**项目/预算**语义（`authorizedMaxSpend` 来自 project authority）。摘"存档基线"是一回事，摘"预算授权"是另一回事——**建议拆分：摘基线，留预算** |

---

## 建议的摘除顺序（若你采纳）

1. **先摘 3**（`DESCENDANT_USER_SAVE_REQUIRED`）—— 一条纯策略，与新原则直接冲突，摘除面最小。
2. **再摘 1 + 2**（血缘确认 + checkpoint 绑定）—— 换成"读世界身份"（`worldId`/`generation`）+ "先读已有则跳过"。
3. **4 与 5 一起摘**（回滚对账 + 回滚锚点）—— 二者互为输入，且 4 有**实测过的假缺失风险**，一起摘更安全；但必须**先固定"读世界"的权威读数**。
4. **6 拆开**：摘基线，**留预算/授权**。

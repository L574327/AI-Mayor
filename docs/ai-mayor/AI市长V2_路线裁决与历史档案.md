> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# AI Mayor V2 路线裁决与历史档案

更新时间：2026-09-20


## 文件用途

本文件用于保存 AI Mayor V2 的重要技术路线裁决。

目的：

防止未来重新打开已经验证失败的路线。

本文件不是当前状态入口。

当前状态请查看：

AI市长V2_接班卡.md

AI市长V2_状态卡.md


---

# 1. 项目核心路线演变


AI Mayor V2 最初目标：

让 AI 语义意图最终转化为 Cities: Skylines II 中真实、可验证的游戏行为。


早期探索方向：

直接构造 native 数据结构。

包括：

- CreationDefinition
- NetCourse
- Connection
- Edge
- Network primitive


后续验证发现：

玩家真实建造流程并不是简单生成数据。


真实链路：

physical input

↓

Unity InputSystem

↓

Game.Input.ProxyAction

↓

NetToolSystem

↓

ToolRaycastSystem

↓

ControlPoint

↓

native validation

↓

native apply


因此：

问题不是“如何生成一个看起来正确的数据”。

而是：

如何让 native tool 自己产生正确生命周期。


最终路线转向：

Native Input Actuation。


---

# 2. Handmade Direct Cable 路线裁决


状态：

停止作为主要架构。


原因：

字段相似不等于 native semantic equivalence。


直接生成：

- CreationDefinition
- NetCourse
- Edge


无法完整复现：

- raycast context
- control point 生命周期
- snap逻辑
- tool state
- validation context


继续维护会进入：

不断补充兼容字段

↓

不断模拟 native 行为

↓

版本风险增加


结论：

停止作为产品主路线。


---

# 3. QueueStateEvent 路线裁决


方案：

通过 Unity InputSystem：

QueueStateEvent(existing Mouse.current)

模拟鼠标输入。


结果：

FAILED。


原因：

它修改的是已有设备状态。

没有形成：

独立 Mouse device

也没有证明：

CS2 消费到了 synthetic input。


最终结论：

失败的是：

针对 existing physical Mouse.current 的方案。


禁止重新作为主路线。


---

# 4. Private NetTool State Injection 路线裁决


状态：

失败。


原因：

需要维护：

- m_State
- m_ControlPoints
- private runtime state


本质：

变成版本绑定的 private state machine shim。


风险：

- 游戏更新容易失效
- 需要持续逆向
- 无法保证长期产品稳定


结论：

不作为产品架构。


---

# 5. Fake Raycast / 局部模拟路线


状态：

失败。


原因：

Raycast 只是 native tool 输入链的一部分。


真实操作还需要：

- press
- hold
- release
- multi-frame transition
- Apply


单独 spoof raycast：

不足以产生完整玩家行为。


---

# 6. Native Interaction 关键结论


已经确认：

CS2 原生工具链本身可驱动。


真实玩家操作能够：

InputManager

↓

ToolRaycastSystem

↓

native ControlPoint

↓

course preview


说明：

后半段 native pipeline 没有问题。


当前问题已经缩小：

不是：

“CS2 是否支持 AI 操作”。

而是：

“如何提供一个 AI 可控制、且 CS2 认可的输入执行方式。”


---

# 7. Virtual HID Mouse 路线


状态：

Windows Virtual HID 技术验证完成。

该路线保留为未来输入 backend，不作为 AI Mayor V1 当前生产路线。


已验证：

- HID设备创建
- 驱动加载
- VHF链路
- Windows Mouse Class
- Windows RawInput
- Windows cursor MOVE / CLICK


完整链路：

AI Mayor

↓

VirtualHidMouseCtl

↓

VirtualHidMouse.sys

↓

Windows HID Mouse

↓

Windows RawInput


当前限制：

Unity InputSystem Windows backend 未将该 OS-backed VirtualHidMouse 暴露为独立 gameplay InputDevice。


已确认：

- Unity InputSystem API 无法强制绑定现有 Windows HID handle。
- RegisterLayout / Matcher 无法解决未枚举设备。
- AddDevice 创建的是 Unity managed device，不是现有 Windows HID。


因此：

Virtual HID 不作为当前 V1 blocker。


当前生产输入路线：

Unity-created Mouse20 InputActuator。


未来如果需要 Windows 级通用输入能力，再研究：

- Unity Windows backend
- native plugin bridge
- custom RawInput integration


---

# 8. Unity Mouse20 InputActuator


状态：

当前生产执行路线。


已确认：

- InputSystem.AddDevice<Mouse>()
- InputUser.PerformPairingWithDevice()
- Mouse20 可加入 gameplay InputUser
- Mouse.current 可保持为 Mouse20
- physical mouse ownership 冲突可隔离


与旧 QueueStateEvent 路线区别：

Mouse20：

创建独立 Unity InputDevice。

不是：

修改 existing physical Mouse.current。


因此：

Mouse20 不属于已失败的 QueueStateEvent 路线。


当前需要完善：

- move
- click
- drag
- scroll
- reset/release
- state/evidence


目标：

完成：

AI command

↓

Mouse20 InputActuator

↓

CS2 native apply

↓

effect evidence


---

# 9. Unity InputSystem Ownership 问题


发现：

存在多个 Mouse 时：

physical mouse 事件可能重新成为 Mouse.current。


根因：

Unity InputSystem 多 Mouse ownership 竞争。


解决方向：

AI控制期间：

隔离 physical mouse。


验证：

ISOLATION_RESULT=STABLE。


结果：

- Mouse20保持current
- physicalMouse无法继续抢占
- ownership transfer停止


---

# 10. 当前未解决问题


## 产品闭环

需要完成：

- Mouse20 placement E2E
- ROAD
- electricity
- water/sewage
- Skill Library 接入


## 产品部署

需要解决：

- 启动流程
- 权限要求
- 异常恢复


这些属于产品化问题。

不是架构可行性问题。


---

# 11. 当前项目真实状态


AI Mayor V2：

不是从零失败。


已经完成：

- AI规划层
- Admission
- Kernel
- Bridge
- native interaction研究
- Native Tool control
- Ownership isolation
- Mouse20 gameplay input


当前缺失：

可靠 autonomous native interaction 产品闭环。


---

# 12. 当前禁止重新打开的路线


不要重新研究：

- QueueStateEvent(existing Mouse.current)
- handmade direct cable
- private NetTool state injection
- fake RaycastResult
- CreationDefinition硬模拟


除非出现新的反证。

否则默认认为路线已经裁决。


---

# 13. 使用规则


本文件用于回答：

“为什么不用以前的方法？”

“不走那条路线会不会遗漏？”

“过去到底踩过什么坑？”


不要用于日常开发。


日常只看：

AI市长V2_接班卡.md

AI市长V2_状态卡.md

---

# 14. 2026-09-23：项目阶段升级

AI Mayor V2 已不再处于“Native Input 是否可行”的主要探索阶段。

当前已进入：

**真实 Skill / autonomous execution certification**

首个真实 Skill：

`skill.K05 CommissionUtilities`

包含：

- Electricity
- Water
- Sewage

当前：

- Electricity：CLOSED
- Water：最后认证阶段
- Sewage：尚未开始

三支完成后：

`K05 CommissionUtilities = CERTIFIED`


---

# 15. Authoritative Evidence 与 Durability 新裁决

当前正式原则：

## World authority

`command success != world effect`

Native command、operation telemetry、journal 状态都不能单独证明成功。

最终以当前世界 authoritative readback 为准。

Net course 必须按：

- exact prefab
- exact course geometry
- split-edge coverage
- concrete matched entity evidence

进行认证。

信息不完整：

`UNPROVEN`

不得伪造 MATCH / ABSENT。


## Save / Load

用户正常：

Save → Exit → Load

属于产品必须支持的路径。

Descendant save 尚未完成 authoritative confirmation 时：

- durable projectState 保留
- write authority quarantine

确认当前世界继承 effect 后：

- 恢复 authority
- 继续原 project

不得因为 reload：

- 重新 admission
- 重新 mint project identity
- 重建已有 facility / network effect


---

# 16. Skill / Knowledge Card 命名裁决

“66 个 Skill”不是正确描述。

当前资料区分为：

- 12 个首阶段核心可执行 Skill
- 12 个后续 Skill（待补全）
- 6 类专项 Skill
- 8 个 Planning Methods
- 66 张 Knowledge Cards

66 Knowledge Cards：

**是专家知识原料，不是 66 个直接可执行 Skill。**

未来用途是：

Knowledge Cards
→ Skill decision rules / constraints / diagnostics / scoring

而不是一次性全部变成 native action logic。


---

# 17. 核心验收路线与长期终极目标

当前剩余主要 Live Gate：

1. Water
2. Sewage
3. Frontage + Zoning
4. Autonomous Neighborhood
5. 3–5 autonomous cycles
6. 30–60 min soak
7. 1-day RC self-play

K05 后另有一次：

K01–K05 Existing Capability → Skill Contract / wiring

该步骤属于集成，不单独计为 Live Gate。


## RC 含义

RC 通过代表：

核心 autonomous mayor 产品链可以稳定工作。

RC **不是能力扩张终点**。


## 长期终极目标

持续扩展 Capability Registry，
直到产品声明范围内达到：

**100% 建设 / 操作类复杂指令覆盖。**

覆盖方向包括但不限于：

- 完整道路体系
- 路口 / 环岛
- 高架 / 隧道 / 桥梁 / 立交
- Electricity / Water / Sewage
- Zoning
- 拆除 / 迁移 / 升级
- 税费 / 预算 / 政策
- 公共交通
- 城市服务
- 必要 UI / management operations

最终目标不是让 AI 只会执行固定 demo。

而是：

复杂自然语言意图
→ Planner 分解
→ Skill / Capability 组合
→ 确定性安全执行
→ authoritative world verification

无法安全完成的能力必须明确返回 BLOCKED_CAPABILITY，
而不是猜测或伪成功。
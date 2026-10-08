# AI Mayor Semantic Compiler — V1 Freeze Candidate

裁决：**READY_FOR_IMPLEMENTATION_FALSIFICATION**

状态：**V1 FREEZE CANDIDATE / SPECIFICATION FOR BOUNDED FALSIFICATION ONLY**。不是生产冻结，不是实现 PASS，不授权本轮开发或施工。第一轮未来实验仅使用 hand-authored MayorIntent；不连接 DeepSeek、GPT 或其他自然语言前端。

日期：2026-10-04 UTC。唯一主要输入为本轮附带的 Unified V0 与 Structural Red Team。未读取仓库、未核验游戏能力、未运行 Compiler、未追加网络研究。下文规范是本轮裁决后的最小契约，不把来源推定当实测事实。

## 1. 冻结架构与保证范围

玩家自然语言 → 外部 AI Semantic Frontend → MayorIntent → 本地确定性 Compiler → Gameplay Policy / Objective Profiles / Templates → Planner → Construction Primitives。

外部 AI 无游戏权限，不是 Mayor，不决定坐标、施工顺序、具体 prefab、道路资产、运行税率或预算动作。Compiler 只解释有限类型语义并降为本地声明，不搜索施工方案。Planner 在有效声明与权限中选择候选；原语兑现候选并回读世界。以下契约由既有边界消费，不新增 Agent、Brain、workflow engine、IntentStack 或通用未来可行性求解器。

五种判断分别记录，不能合并成一个 supported/PASS：

| 层 | 可承诺什么 | 不能推出什么 |
|---|---|---|
| Natural-language fidelity | 原句的否定、范围、强度、方面、时态、更新对象是否被保真表达；需独立原意 oracle | 原话存档、schema 合法、前端 confidence 均不能证明保真 |
| IR validity | 版本、类型、单位、引用、有限参数与更新结构合法 | 合法 IR 可能误译原句，或表达无解要求 |
| Compilability | 不经自由语言推理，可唯一降为有限本地契约，或唯一给出诊断 | 契约存在不表示当前可执行或有解 |
| Executability | 当前世界、能力、资源、有效许可、门控、影响证据允许相关推进 | 原语存在不证明结果已达成；合法候选不保证所有目标最终可解 |
| Verifiability | 有针对原目标、量化域、时态和证据质量的有效 evaluator | 可观测不等于已满足；代理满足不等于原义满足 |

本轮 fidelity 标为 **NOT_TESTED**，不得因手写 IR 实验通过改为 PASS。游戏能力的 EXACT / APPROXIMABLE / UNSUPPORTED 与上述五层分开；EXACT 只对指定谓词或能力含义有效，绝不跨层继承。

## 2. SF01–SF10 逐项审判

判定口径：VALID＝V0 缺少承重规则；PARTIALLY_VALID＝V0 已明确防住部分错误，但交界仍未闭合；ALREADY_HANDLED＝完整反例已有唯一规范结果；INVALID＝反例不成立。本轮没有为追求分类分布而强行分配标签。

| ID | 裁定 | V0 依据与未闭合部分 | V1 最小关闭位置 |
|---|---|---|---|
| SF01 | PARTIALLY_VALID | §0.1、§3.1 已区分表达和本地能力，source 只追踪；但 §4.1 validation 不能核验任意原句等价性。红队正确指出保真未证，并非证明有限 IR 架构失效 | §1、§4 固定保证边界与类型语义；前端保真留独立验证 |
| SF02 | VALID | §4.2.4 要求显式 exception/revision，S04 要求许可不能绕 preserve；未规定例外指向哪个规则、如何保留残余域 | §5 的定向裁剪与联合求值 |
| SF03 | VALID | §5.1、§5.2 防住物理回滚，却没定义取消补丁与恢复旧声明的区别 | §6 的取消对象、永久替代与显式恢复 |
| SF04 | PARTIALLY_VALID | §5.4 已明确等待持续有效、§5.2 禁止授权无限续期；缺条件/专项 grant 的 owner、存续和完成后处理 | §4、§6 的 owner、binding 与失效规则 |
| SF05 | VALID | S01/S03 有 SNAPSHOT/baseline，§4.1 又从 Latest World 解析；没有明确一次捕获、稳定身份与无关修订不重取样 | §5 的接受时绑定和基线身份 |
| SF06 | PARTIALLY_VALID | S03、D02 和 §4.4 已覆盖隐式拆除与间接影响；缺有限覆盖域和相关影响 UNKNOWN 的准入结果。不能要求无限未来模拟预测 | §5、§7 的有限影响证明与保守阻塞 |
| SF07 | VALID | §4.2.7、M11 允许“不破坏未来可行性”的独立推进，M11 明示证明方式未决 | §7 的有限独立性证书，证据不足阻塞 |
| SF08 | PARTIALLY_VALID | O01–O16 已分轴，§4.2 禁止 hard 被抵销；C02/M12 未给 backend 写效果、隐含假设、soft 平局和组合冲突规则 | §8 的映射契约与顺序无关合并 |
| SF09 | VALID | §4.3 和 M06 已说 Mission 高于 Profile、不发明底线；未关闭 Profile 以永久等待绕过 Mission 的活性漏洞 | §10 的来源分类、合法候选与拒绝原因 |
| SF10 | PARTIALLY_VALID | §4.2.5、§4.3、F01–F03 已防代理冒充和计划/结果混用；缺空集合、分母变化、缺测、持续目标和 required residue 的总聚合 | §9 的量化与完成契约 |

以上关闭指**规范具有确定结果**；不声称代码已关闭漏洞。SF01 的任意自然语言保真不是靠修订 Compiler 自动解决，而是明确排除其未证保证。

### R01–R06 落实索引

| 要求 | 本文条款 | 必须产生的可检查结果 |
|---|---|---|
| R01 typed semantic / fidelity boundary | §1、§4、§12 | 固定类型、显式极性；合法误译不会被冒充为 fidelity PASS |
| R02 scope / exception / preservation / permission | §5、§7 | 残余限制、保护基线、逐影响许可、UNKNOWN veto |
| R03 lifecycle / atomicity | §6 | 完整候选修订或原状态；无旧规则复活、无孤儿 grant、无无关重取样 |
| R04 hard / unsupported / UNKNOWN / composition | §7、§8 | hard 相关阻塞，独立性证书或明确缺证诊断 |
| R05 approximation / completion | §9 | 近似授权定位、原义保留、三值证据、量化域与总义务聚合 |
| R06 Mission / Profile | §10 | hard/resource/profile 原因分离，Profile 不提权、不静默永久否决 |

## 3. Ontology 保持 16＋5，不扩词表绕问题

领域概念与结构语义是参数化词汇，不是必须新造的 21 个运行系统。表中“候选效果”只说明合法 lowering 类型，不认证当前 backend 已具备。

| ID / 名称 | 语义与允许参数 | 候选本地效果；禁止隐含意义 |
|---|---|---|
| O01 STYLE | 外观谱系、时代、材质/装饰的已注册限定 | 资产/主题候选过滤；不附带密度、道路形状、拆迁 |
| O02 URBAN_FORM | pattern、grain、街墙/退线、中心结构 | 几何/布局约束；有机感不等于随机抖动，城市名不等于模板 |
| O03 DENSITY | zone_class、人口/面积、FAR、coverage、height；单位、分母、planned/built | 各指标独立过滤/目标；高密不等于高楼或紧凑 |
| O04 EXTENT | 连续性、增长边界、飞地、infill/outward、方向倾向 | 区域/购地候选约束；不自动升密或授拆迁权 |
| O05 LAND_USE | 既有用途类别、subtype、主次、明确比例及分母、空置 | 用途约束/禁止 infill；不保证具体店铺，空置不授先拆权 |
| O06 USE_MIX | horizontal/vertical、共存用途、尺度与程度 | 支持的 mixed zone / 空间分配约束；水平混合不冒充任意竖向叠加 |
| O07 MOBILITY | 模式、功能层级、通透性、货运限制、通达、冗余 | 网络/路径/使用目标；邻近、连通、实际使用分别验收 |
| O08 PARKING | 供给、地面/地下、收费倾向与 scope | 停车类别/政策约束；禁新增不自动删已有，不由倾向生成费率 |
| O09 OPEN_SPACE | 类型、数量、分布，关系引用 O15 | 开放空间/设施/预留偏好；公园数不等于漂亮，树不证明治污 |
| O10 ECONOMIC_ROLE | 制造/物流/办公/旅游/资源/居住支持/多样等既有角色及主次 | 用途/需求/对外连接偏好；角色不是 Profile 或盈利保证 |
| O11 HOUSING_CONDITION | 可负担、租金/财富指标、混合、受益群体 | 有证据的住房/服务偏好；低租不等于棚户，不能用驱逐偷达标 |
| O12 ENVIRONMENT_QUALITY | 空气/地面/水/噪音/能源等分别定义；受体、阈值、时域 | 原结果谓词和治理约束；距离、种树、方位不能替代暴露结果 |
| O13 AESTHETIC_CHARACTER | 原话及既有有限质性轴、resolution | 有批准近似才有写效果；否则 residue/NON_BINARY，无通用 beauty KPI |
| O14 VARIATION | vary_axes、程度、跨域分布 | 指定属性的异质性约束；本地 seed 不是“真实”的定义 |
| O15 SPATIAL_RELATION | near/far/along/facing/surround/connected/opposite；度量/参考；buffered/gradual/screened | 几何/网络/界面约束；缓冲不是安全证明，along 不能任意放大 |
| O16 SITING | wind/water-flow/slope/resource/shore/risk、side、reference | 已观测物理场条件；下风不是南方，不自动推山或随风搬迁 |
| S01 SCOPE | 有界集合、SNAPSHOT/DYNAMIC、包含/排除/交集、接受基准 | 本地绑定和影响边界；不是 District 或权限优先级 |
| S02 REFERENCE | 本地 opaque handle、特征种类、既有声明引用 | 唯一绑定；同名不替代同实体，云不得造 ID |
| S03 PRESERVATION | scope、方面、baseline、强度、AI 操作边界或明确世界结果契约 | 影响 veto / 独立结果目标；不默认暂停自然模拟 |
| S04 INTERVENTION_PERMISSION | READ_ONLY / ADD_ONLY / 有限允许或禁止改变类别；范围、方面、目的限制 | 权限 envelope；许可不是建设目标，不绕过保护 |
| S05 TEMPORAL_CONDITION | 注册谓词、BEFORE/AFTER、显式放行、单次门、REACH/MAINTAIN、时间基准 | 目标/许可门；不是 Profile 序列或施工工作流 |

服务类型沿用 LAND_USE，人口/财政/服务容量等使用注册 metric，不新增概念。vacant hold 使用空置目标＋MAINTAIN＋禁止填充。名城、CBD、工业港等只能引用已注册语义面，不能整包加未说出的属性。

## 4. MayorIntent V1 的类型与最小信息契约（R01）

这是语言无关的规范，不是 TypeScript/C# 或施工数据。所有枚举、谓词、selector、参数键均版本化、有限注册；未知项保存诊断，不自由执行。

### 4.1 Envelope 与声明字段

| 层 | 必须字段或明确默认 |
|---|---|
| Envelope | schema_version、ontology_version、mission_ref（本地分配或核验）、update_id、base_revision、operation、source；初始提交使用明确空基准 |
| 更新内容 | 显式 add / replace / cancel / exception-edit 的目标引用和范围；未指定项恒保留，不提供隐式清空开关 |
| Clause | 稳定 clause_ref、kind、semantic_content、scope_ref、applicability、source_span、owner、modality（适用时）、temporal_binding、completion（目标适用时） |
| Content | 一个既有 concept 的有限参数，或一个注册 metric/predicate 的类型化条件；不接受自由代码 |
| Applicability | 对已有/未来对象的适用域、方面、观测态和时域；不能靠概念名猜 |
| Owner | INDEPENDENT 或绑定一个明确 target_ref。未声明目标专属关系不得猜 owner；有依赖的含糊更新阻塞 |
| Residue | 原话、涉及方面、REQUIRED/PREFERRED、AMBIGUOUS/OPAQUE/OUT_OF_BOUNDARY 等原因、关联引用；无写效果，但保留义务 |

`update_id` 只用于同一接受单元的重送识别，不引入新执行平台。命中已接受的同 ID 同内容返回原语义结果，不重取样、不续期、不重耗额度；同 ID 不同内容拒绝。不同 ID 带旧 base_revision 拒绝 STALE_REVISION；不会静默 rebase。

### 4.2 固定语义

- **TARGET**：期望状态/结果，不赋权限。REQUIRED TARGET 在到达前可以 FALSE；它不是每一步必须已经满足的 invariant。
- **CONSTRAINT**：适用期间的硬准入条件，或明确标注的终态约束。禁止是 `NOT(注册谓词)`，不是低权重偏好。
- **PREFERENCE**：合法集合内的软排序，不授权、不解除门、不改指标。
- **PRESERVE**：保护指定对象与方面的本地接受基线；REQUIRED 时为写操作 hard。PREFERRED 仅为合法集合内的避免损失偏好，不得暗示硬保护。
- **PERMISSION**：ALLOW 或 FORBID，限定操作和受影响方面；ALLOW 不表示必须发生，FORBID 属硬边界。
- **存在**：使用注册 EXISTS/计数谓词及类型域。“不得没有商业”不能变成商业 FORBID 或 ALLOW。双重否定仅对同一明确类型化谓词作布尔消去；“建设动作存在”与“区域商业存在”不可互换。
- **例外**：是对明确 rule_ref 的修订，不是新增泛化 ALLOW；详见 §5。
- **优先级**：只排序软偏好或明确允许的目标推进取舍；hard 不参加权重抵销。目标 urgency 不覆盖门和权限。
- **描述/疑问**：世界事实描述只作待核输入；只读诊断不是写目标。Compiler 不从 source 重新发掘隐藏命令。

玩家明确的数值结果阈值可保留，必须具 metric、单位、分母、scope、planned/built 和比较符。未给出的“低层”“稳定”不得填任意六层/三个月。第一实验中含糊参数直接拒绝相关 lowering，保留声明。

### 4.3 Temporal 与所有权

每个门具有 gate_ref、被门控的明确 target/grant refs、注册 predicate 或明确玩家 release_event、时间基准和触发方式。CURRENT_TRUE 表示每次提交均须当前为 TRUE；LATCH_ON_TRUE 表示在接受之后观测到 TRUE 才锁存放行。事件门为一次显式匹配 release_event；任何新消息、style PATCH、回合或窗口切换都不匹配。方式必须明确，禁止临场猜“到两万人”是否永久锁存。

门关闭或 UNKNOWN：阻塞被门控写操作，不删除目标。解除门也不产生许可。绑定 target 的 gate、grant 与近似授权在 target CANCEL/REPLACE 时失效；无关目标不受影响。独立保护默认 INDEPENDENT；删除目标不删除保护。专属 grant 在 target REACH 达成并关闭追求后失效；若需要用于持续维护，必须显式绑定仍有效的 MAINTAIN 目标。独立 grant 按自身边界存续，不因目标变化续期。

## 5. Scope、例外、保护与权限联合求值（R02）

### 5.1 绑定

SNAPSHOT 在**修订原子接受时**绑定一次：world/session identity、对象稳定身份或固定本地地理域、selector 版本、参考锚点、方面基线与接受时间。几何域与实体集合必须区分：固定地理域可覆盖其中未来操作；固定实体集合不会自动吸纳后来同名对象。

无关 PATCH、能力变化、重新编译只重验，不重捕获。对象消失标 MISSING；同名新对象不替代。自然变化报告 baseline divergence，不自动恢复原样，也不把最新状态写成旧基线。读世界回答“现在如何”，原接受记录回答“当时保护什么”。

DYNAMIC 使用固定 selector、有限 universe、固定参考锚点/规则，每次从世界重求集合；新增成员按同规则纳入。若保护方面需 baseline，每个新成员首次入域时绑定一次，离域不删除已有身份基线；再入域不重新取样。域成员变化和基线变化分别报告。锚点失效或 membership UNKNOWN 时阻塞可能受影响的写入，不改用新市中心。第一实验只需合成 selector 证明规则，不实现任意自然地理解析。

### 5.2 定向例外

例外必须带被修改的旧 rule_ref、限定 scope、方面、时间域与有限操作类别。只把该旧规则在这些维度的交集部分裁掉，残余限制保留；交集未知则不能接受裁剪。裁剪是已接受修订对旧声明的显式改变，不是 scope 大小优先或 last-write-wins。

默认例外域在接受时 SNAPSHOT 固定，不随城扩张扩大；若需 DYNAMIC 例外必须显式声明选择规则并逐次求交，UNKNOWN 仍保守保留禁令。独立保护和其他禁令不因例外删除。改变 preserve 必须指名该保护规则及方面，普通 demolition 例外不改变 preserve。

例如，全城禁拆 F＋地铁硬保护 P，明确在东区 E 对 F 开放建筑重建：得到 F 在 E 外的残余＋P 全部原域＋E 内限定重建 grant。东区其他方面仍按旧规则；西区禁拆，地铁禁止，东区无必拆目标。只有 ALLOW、没有对 F 的显式修改，F 在东区仍有效。

例外修订不以“后来取消关联建设目标”自动回滚：取消目标关闭其 grant，但不复活被替代的旧声明。要恢复东区禁拆必须显式追加/恢复该限制；仍无任何默认写权。该选择与 §6 的无旧规则自动复活一致。

### 5.3 候选操作的有限影响契约

候选由 Planner 提供，Compiler 不生成坐标。候选描述须关联当前接受 revision、world generation、目的 target refs、操作类别，以及每个相关方面的影响摘要和覆盖声明。影响至少区分直接写入、引擎隐式删除/替换、可检查的接入/管线/用途/外观连带改变；注册能力只声明它实际能检查的方面。

不能承诺无限未来经济/人口因果。AI_DIRECT_INTERVENTION 保护针对操作及已注册确定连带效果；若玩家要求接入不失效，就加入接入方面并要求相应证据；若要求世界长期不变，必须另有结果型 MAINTAIN evaluator。只保无 AI 拆改不能回报世界永久不变。

对于每个受影响对象/方面，联合求值：

1. 引用、目的、世界与修订有效，相关门 TRUE。
2. 所有适用 hard 同时满足；目标尚未达到不误作 invariant 违规。
3. required preserve 没有被破坏；相关影响完整性为 TRUE。
4. 有效 ALLOW 覆盖相应操作及受影响范围/方面，所有仍有效 FORBID 均不命中。
5. grant 的目标用途、期限、来源筛选、对象限制和额度满足；实际资源与引擎前置条件满足。

任一 FALSE 给具体拒绝；任一相关 UNKNOWN 给阻塞，不把 UNKNOWN 当“没影响”。操作坐标在东区不意味着西区影响有权。多个允许类别可在已授权的有限范围合并，但禁止及保护取交，ALLOW 不压倒 FORBID。所有写权限均须来自有效明确授权或已存在、明确记录的产品权限基线；本稿不默认“有目标就可写”。

拆迁需“改变既有世界的明确目标＋匹配的 destructive grant”两把钥匙；可在同一次请求同时给出，无需强迫重复确认。grant 最小字段为 scope、operation_categories、affected_aspects、purpose（INDEPENDENT 或 target_ref）、validity（明确期限或 EXPLICIT_UNTIL_REVOKED）。玩家给出数量/指定对象/来源限制时必须逐项保留；未给数量不私造上限。依赖作者筛选时 provenance UNKNOWN 阻塞该影响，选区保护不要求作者历史。

额度按唯一原语操作的已提交受影响对象消耗；生成计划不耗额度。在途结果/额度消耗未知时阻塞再次使用相关额度，直到读回或可靠提交证据明确。修订不把已用额度清零，也不续期。不要求新账本，仅要求既有操作记录不能把未知消费当零。

## 6. PATCH / REPLACE / CANCEL 与原子性（R03）

### 6.1 唯一生命周期

| 操作 | 声明结果 | 保留/失效规则 |
|---|---|---|
| PATCH | 只 add 或显式替换引用的 clauses/片段；局部变更裁出旧片段并安装新片段 | 未指定声明、等待、保护、基线、独立许可恒保留；被替代片段永久不活跃 |
| REPLACE | 替换显式引用/有界集合内的目标及偏好 | 不默删范围内保护、FORBID 或独立许可；修改它们须逐项显式引用。绑定被替换目标的门/grant 失效 |
| CANCEL | 关闭明确目标/片段的未来追求 | 已建、已提交 zoning 不回滚；独立规则仍在；专属 gate/grant/近似失效；不复活被替代旧片段 |
| PRESERVE | 在该接受单元中添加指定对象/方面的保护 | 只建立新保护自己的 baseline；不重取已有 baseline |
| 显式恢复旧声明 | 以新的 PATCH 引用历史内容，检查当前 scope、保护、权限与能力 | 只恢复未来声明；不恢复世界、不自动复用旧 grant 或旧期限 |

“取消刚才改动”若未唯一说明目标/补丁及效果，不提交更新；当前接受声明仍在，相关 pending 写操作暂停并诊断 AMBIGUOUS_CANCEL，独立工作可按 §7 继续。暂停只限制提交，不产生新授权或撤掉旧保护；明确更正/撤回该未接受更新后解除这项暂停，再按当前接受集重验，不能留下无来源的永久停滞。手写 IR 必须选定 CANCEL target 或显式恢复，不能让 Compiler 读原话猜。

局部替代采用有限声明片段及稳定 derived refs；不引入 stack。A 欧式全域被 B 在东区替换后，A 东区片段不再活跃。C 取消 B 时，东区不会自动恢复欧式；其他独立人口目标仍可有效。原保护、有效许可和实际世界继续约束新候选。

### 6.2 接受事务与诊断

一次 update 是一个原子语义接受单元。步骤为：校验 base/update identity → 建立候选声明集 → 验证所有引用与裁剪 → 准备必要 scope/baseline → 检查声明级确定 hard 冲突及 owner 闭合 → **一次安装完整候选 revision**。安装前必须确认用于绑定的 world/session identity 与 generation 仍有效、base_revision 仍是当前版本；若并发变化导致基准失效，整个接受单元重验或拒绝，不混用两份世界捕获基线。任一步失败，旧接受集不变，不先撤限制再补新限制。内部多个编辑不自动部分接受；若需拆分，由提交者提供独立 update，不能由 Compiler 默拆。

区分两种失败：

- 更新结构/引用/绑定/确定语义冲突失败：REJECTED，旧 revision 原封保留，相关风险写入暂停。
- 声明合法且语义确定，但 mapping/原语/evaluator 缺失或当前门/资源不满足：可整体接受为目标声明，产物对相关部分 BLOCKED。acceptance 不是 permission 或 executable PASS。

无法绑定的 required scope 不能先删除旧保护再保留“待解析新保护”。可明确表示 residue 的目标可保留，但不能从未绑定 residue 产生写效果；相关工作按 §7 保守阻塞。

提交边界必须核对 latest accepted revision 和世界 generation，并再次做相关影响/权限准入。旧待提交计划失效或重验，不能靠生成时合法继续。已提交在途操作若原语无法取消，按真实事实报告，阻止后续不合法提交；不能许诺完美撤回或自动补偿拆迁。语义原子性不伪装成游戏物理事务。

## 7. Hard、UNSUPPORTED、UNKNOWN 与部分推进（R04）

谓词求值统一 TRUE / FALSE / UNKNOWN。UNSUPPORTED 是能力缺失诊断，不是 TRUE 或零测量。确定 hard-hard 矛盾给冲突引用、交叠域、方面与时域；容量待判是 FEASIBILITY_UNKNOWN，不冒充逻辑矛盾。

hard invariant、permission、required preserve 的相关真假未知均阻塞写准入。required TARGET 尚未达到通常允许合法推进；但**无法检查或兑现的 required hard 结果承诺**不能被拆开成“先建手段以后再看”。距离 mapping 无权替代零污染。

### 有限独立性证书

允许与未支持/未知义务并存的部分推进，必须从注册 mapping 和当前证据给出以下全部项目，不由 AI 或不同 concept 名称判断：

1. 相关未解义务的 scope、方面、时域和共享依赖已知；未知范围不能证明不相交。
2. 候选已知影响与未解义务的禁止域不交叠，相关影响覆盖完整。
3. 已声明的未来土地/容量/资金需求若共享，具有**已绑定保留域或注册保守上界**，候选不会消费它们；无法给上界/保留证据则共享资源未知。
4. 不使用未解义务的 gate/grant，不制造其独有且无兑现依据的依赖；全部已知 hard 和权限仍通过。

任一缺证，阻塞相关部分 INDEPENDENCE_UNPROVEN。无需证明任意城市未来可行；可通过拒绝无证部分守住边界。两个地区共用未知现金/供水容量不能仅因几何分离声称独立。零污染港口工业与住宅不能先消耗选区；但已有独立授权、影响不相交、资源预留可核对的别区工作可以继续。

软 unsupported 留 residue 与损失诊断；无写效果，也不阻塞有完整证书的工作。required OPAQUE 因范围/影响不明而可能阻塞更多工作，这不是全局永久拒绝规则。

## 8. 有限 Mapping 与效果组合（R04）

每个可执行 mapping 必须注册：mapping/version、接受的类型化输入、原义保证与损失、读取事实、前置条件、输出 effects、写入的 policy/template 参数键、附带假设、影响覆盖、required observation/primitive/evaluator、approximation 授权要求、已验证组合方式。不满足登记要求即 LOCAL_MAPPING_MISSING。

所有参数来自有限本地 mapping，不来自前端施工计划。模板的附带密度下限、贷款、拆迁、推山不能因“实现方便”加到玩家语义上；若模板需要这些条件，必须已有声明允许且所有 hard 兼容，否则模板不可用。

合并顺序固定：

1. 解析有效声明与例外，独立保留不同轴。
2. 同键/同域/同时的 hard 限定取交；定义域或合并算子缺失则 EFFECT_COMPOSITION_UNDEFINED，不顺序覆盖。
3. 全部 preserve/permission/gate 对效果共同求值。
4. 对合法候选采用注册 soft 等级的词典序评价。每个等级内部聚合算子须注册；未注册的同键冲突软项均不写该键，报告 SOFT_TIE_UNRESOLVED，不暗猜一方。
5. 评价完全相同可用规范化稳定本地 mapping 标识排序；不得使用子句输入顺序或 provider。丢失的软偏好逐项报告，权限/原义有差异不得靠平局规则裁定。

Compiler 输出约束及允许参数域，不实施路线搜索。LOW_RISE＋HIGH_DENSITY 分别保留高度与密度，物理可行性未知可诊断；COMPACT 不写 density floor；欧洲外观不带 Tokyo 密度；同网络同尺度纯 GRID 与 NOT GRID 才是确定矛盾，不把 ORGANIC 自动翻成 NOT GRID。未有组合 mapping 可以拒绝该兑现，不扩大 Ontology。

## 9. 近似授权与 Completion Contract（R05）

### 9.1 近似授权

每项近似绑定 target/clause_ref、aspect、scope、原解释版本、proxy mapping/version、允许损失和验收口径。仅在这些边界内有效，目标替换或 proxy 含义改变须重新核验授权；不传给污染/财政/保护等其他轴。

玩家允许 soft 外观近似，可消费已批准外观代理并报告损失；不会解除污染 hard。hard 原要求永不自动降级。玩家明确接受替代时，以显式 revision 保留“原目标被替代”的记录，并对新代理目标验收，不追溯宣称原义成功。能力增加可改善 active typed 目标兑现，但不扩大 grant、不解除门、不执行先前 residue 隐藏内容。

### 9.2 每个 evaluator 的必填契约

| 项目 | 固定内容 |
|---|---|
| 义务身份 | clause_ref、原目标/代理分别标记、解释与 evaluator 版本 |
| 量化域 | SNAPSHOT 对象集或固定 DYNAMIC selector；受体、关系两端、已有/未来、planned/built |
| 指标 | metric、单位、比较符、阈值、分子/分母的完整定义，面积是否包含道路等 |
| 存在/规模 | 非空要求、最小目标规模或玩家明确允许 vacuous truth；不得由优化器任意选 |
| 集合变更 | 允许的新增/移出/自然变化、对象丢失处理；不为达标主动缩域或换分母 |
| 时态 | REACH / 有限窗口 MAINTAIN / OPEN_ENDED MAINTAIN / NON_BINARY；时钟与采样覆盖 |
| 证据 | 数据源、world identity、时间/generation、精度、缺测/过期判据、覆盖与归因界限 |

自然语言未给必要口径时，不发明目标：相关 completion 为 CONTRACT_UNRESOLVED。对于“工业不污染住宅”的空住宅集合，除非存在义务/空集口径已明确，否则 UNKNOWN，不能默认 TRUE，也不擅自新增“保留所有居民”。人口密度使用固定约定选区面积，不能只统计入住地块。原义若明确允许无住宅作为隔离结果，则按该契约验收，但这仍不授权拆迁。

缺测、无覆盖、精度不足、过期、对象丢失未有处理依据均 UNKNOWN；零污染若传感精度不能支持零断言，只能报告观测边界内值，不声称绝对零。直接 world readback 优先于模拟猜测/提交日志；历史 baseline 仍用于说明原承诺对象。

### 9.3 时态与聚合

REACH：在有效、覆盖完整的指定域证据中达到阈值可标 REACHED，记录时间；若目标还附持续约束须继续单独报告。有限 MAINTAIN：只有完整窗口达到采样覆盖、全部相关谓词 TRUE 才 WINDOW_SATISFIED；缺测 UNKNOWN，窗口中 FALSE 则 VIOLATED。不得删除失败样本偷缩窗口。OPEN_ENDED MAINTAIN：只能 ONGOING_SATISFIED / VIOLATED / UNKNOWN，不给永久 COMPLETE。NON_BINARY 不提供自动数值完成率，若需用户判定必须声明其有限判定协议，不由模型造美学分数。

总体报告至少包含：接受 revision、五层状态、每条 active required 义务、全部 residue、软偏好损失、原义/代理分别证据、阻塞及自然变化。取消/被替代义务明确标 CANCELLED/SUPERSEDED，不算完成，也不从历史中消失。

仅当**所有 active required 义务具有效完成契约并在其时态内 TRUE、没有 required UNKNOWN/UNSUPPORTED/OPAQUE、没有开放式维持义务**，才可对该限定 Mission 报 COMPLETE。required preserve/invariant 还需相关期间有效操作与覆盖证据，不能仅看“日志没拆房”。软质性项未达成不阻止有限 required 指标完成，但报告必须写“required 指标完成；质性偏好未验证/损失”，不得据此声称整体巴黎感、美学已完成。

规划约束满足、原语已提交、施工读回、结果已达成、持续条件满足分别标证据；PARTIAL 并不赋任何额外施工权。

## 10. Mission 与四种 Profile 的权限边界（R06）

保留 FINANCIAL_RECOVERY、FAST_EXPANSION、AUTONOMOUS、BALANCED。Profile 只决定有效边界内的经营偏好和候选排序，不是玩家最终目的。

| 来源 | 准入地位 | 示例 |
|---|---|---|
| 玩家 hard / 有效权限及保护 | 不可被 Profile 改写 | 禁贷款、现金底线、禁拆、等待放行 |
| 引擎、实际资源、原语能力 | 事实前置条件；带来源证据 | 现金不足支付、未解锁、操作不可用 |
| 明确已授权产品操作边界 | 有效期间遵守，独立标来源 | 只读/有限写入边界；不能偷塞未授权财政底线 |
| Profile 的收益/现金缓冲/经营节奏 | 软偏好，可让步，不能标系统 hard | 先等盈利再扩张、贷款偏好、批量节奏 |

允许亏损不创造现金、不取消玩家现金底线、不默认授贷款权。Profile 推荐融资仍须明确允许操作及其他硬约束通过。系统不以常识发明“永不破产”的玩家目标。

活性契约限于已知候选：当既有 Planner 提供一个当前可执行、已授权、满足全部 hard 的候选，而 Mission 明确要求现在推进，Profile 不能仅以其软盈利/缓冲阈值否决该候选；下一次正常候选决策须允许它进入合法选择集合，并报告哪些 Profile 偏好让步。此处不规定施工方案或新调度层。

若没有候选，报告 NO_CANDIDATE / SEARCH_INCOMPLETE，不宣称世界无解。若全部候选被 hard/resource/UNKNOWN 拦截，报告对应引用与证据。若唯一拦截是 Profile soft，报告 PROFILE_ONLY_STALL 并撤去该软 veto；不能循环伪装“资金未稳定”。该规范保证 Profile 不暗中否决，不保证 Planner 能找到任意解或永久有解。

## 11. 编译接口、顺序与确定性

### 输入

MayorIntent update、已接受声明/稳定绑定/有限修订上下文、Latest World snapshot、Capability Set（mapping/观测/原语/evaluator/内容分别列）、本地 Gameplay Skill/Templates、四种 Profile 及各自版本、有效产品权限基线、既有提交/在途证据。世界事实与历史语义基线分别使用；provider 不参与语义选择。

### 输出

AcceptedRevision 或 RejectedUpdate；GoalSet、ConstraintSet、SpatialPreferenceSet、PreservationRules、PermissionEnvelope、FiscalEnvelope、TemporalConditions、允许的 Policy/Template 参数域、CompletionCriteria、逐条 Diagnostics 与 provenance。接受集和可执行子集分别列出；无施工坐标、工具调用或批次顺序。

每条 effect 至少追到 clause_ref / mapping_version / world evidence / 有效 grant 或禁止规则；例外显示旧规则残余域；拒绝显示相关 FALSE/UNKNOWN 及原因。不输出单一 supported 布尔值替代五层。

顺序：类型/版本校验 → 构造完整候选修订及稳定绑定 → 语义/引用/owner/确定冲突检查 → 原子接受 → 能力解析及有限效果组合 → permission/preserve/temporal/fiscal 联合 lowering → hard/未知/独立性诊断 → completion lowering。候选提交由既有执行路径重新准入，不借“编译成功”跳过世界变化检查。

确定性范围：完整 IR、accepted context、世界快照、能力/规则版本、授权基线、有限时间/事件输入均相同时，规范化语义产物、权限集合和诊断相同。排除 provider 名、输入子句排列、日志时间戳和本地生成显示 ID；SNAPSHOT 已绑定记录视为输入。显式 revision 时间顺序不能任意交换。规则版本升级须声明迁移，不能重新解释旧语义或续期授权。

最小诊断码：INVALID_IR、STALE_REVISION、UPDATE_ID_COLLISION、AMBIGUOUS_REFERENCE/CANCEL、SCOPE_UNBOUND、HARD_CONFLICT、FEASIBILITY_UNKNOWN、GAME_LIMITATION、CONTENT_UNAVAILABLE、LOCAL_MAPPING_MISSING、OBSERVATION_MISSING、PRIMITIVE_MISSING、EVALUATOR_MISSING、OUT_OF_BOUNDARY、EFFECT_COMPOSITION_UNDEFINED、IMPACT_UNKNOWN、PERMISSION_DENIED、GATE_CLOSED/UNKNOWN、INDEPENDENCE_UNPROVEN、CONTRACT_UNRESOLVED、EVIDENCE_UNKNOWN、SOFT_TIE_UNRESOLVED、PROFILE_ONLY_STALL。每码附具体引用，不靠名字代替解释。

## 12. 第一轮最小实现证伪实验边界

本节为未来实验规范，本轮不写产品代码、不启动实验。目标仅验证 hand-authored MayorIntent → deterministic Compiler 的核心契约，禁止把实验包装成 AI Mayor 全产品已实现。

### 12.1 允许与排除

允许：单进程纯编译函数/等价测试装置、合成世界 fixture、已绑定本地 opaque handles、微型有限 mapping/capability 表、假候选影响与 evaluator 证据、现有测试运行器。拒绝/阻塞是合法预期结果，但不能用“全部拒绝”通过。

排除：自然语言前端、DeepSeek/GPT 请求、游戏 MCP 写调用、真实施工、通用 spatial resolver、全 21 概念 backend、新 Agent/Brain/workflow、UI、部署、任意未来可行性求解、扩词表、其他项目重构。source 原句只作测试注释，编译器不能读取它解释语义。

最小 fixture 词汇仅需：有限东西区/全城/地铁/建筑句柄；commercial/residential/industrial/vacant 用途；appearance、density/height、grid 谓词；人口/现金/污染/噪音测试 metric；许可、保护、门控与目标引用。它们来自既有 Ontology，合成污染测量不认证游戏已有污染能力。正向虚拟 mapping 至少覆盖普通加用途、一个合法局部改造、一个 style PATCH、一个有限结果 evaluator。

### 12.2 最高杀伤力 cases 的独立 oracle

测试作者先冻结下面的预期状态/集合/诊断，再实现 Compiler；不得用 Compiler 自己生成 oracle。K 编号沿用红队摘要；原句不是声称已获得全部 Grok gold corpus。每行同时检查状态、权限、门、基线及 completion，不能只匹配一个错误码。

| Case | 手写输入与 fixture | 必须观察到的唯一结果/对照 |
|---|---|---|
| K01 极性 | 商业 FORBID 对照 REQUIRED EXISTS(commercial) | 不同产物；exists 不产 demolition grant。合法误译 IR 对照只能证明 fidelity 未测，不能期待 Compiler 自动纠正 |
| K02 外观保路 | 外观偏好＋道路 preserve；appearance mapping 缺失 | 外观 residue；道路保护保留，无放射路网副作用 |
| K03 有界补集 | 全城 U 减东区 E 的 preserve | 保护 U\E；东区没有自动拆权；对 U 未绑定给阻塞 |
| K04 定向例外 | 全城禁拆 F、独立地铁 P，显式修改 F 在 E、匹配 grant | E 普通建筑的合法候选可准入；西区和地铁拒绝；仅加 ALLOW 不改 F 的对照仍拒绝 |
| K05 隐式拆楼 | 许可改路但道路拓宽影响受保护建筑 | preserve veto；已证实无楼影响的改路对照可准入 |
| K06 方面连带 | 外观 preserve、用途可改，用途动作分别更换/不更换模型 | 前者拒绝，后者在其他条件具备时准入；未知模型影响阻塞 |
| K07 基线 | 西区 snapshot，世界自然变化，再 PATCH 东区外观 | 西区原对象与 baseline identity/bytes 不变；报告 divergence，不重取样/自动重建；同名新对象不替代 |
| K08 取消替代 | A 全域欧式，被 B 替代东区；取消 B | B 未来追求关闭、已建不动、A 东区不复活；显式 restore 的对照只恢复未来声明，旧 grant 不复活 |
| K09 专属许可 | 地铁目标＋人口门＋为地铁拆房 grant，取消地铁 | 三者关联活动失效；独立保护和其他目标存续 |
| K10 无关 PATCH | 未 release 的扩张事件门，PATCH 屋顶 | 等待不变；显式匹配 release_event 的对照才放行，且仍需权限 |
| K11 grant 目的/额度 | 专属东区两栋 grant，取消该目标，另建商业 | 商业无权复用；重送 update 不续期/恢复已用额度，未知在途消费阻塞 |
| K12 hard 未支持 | 零污染 required＋仅距离 mapping，候选先建工业住宅 | 不产生代理 hard 满足；相关施工阻塞 INDEPENDENCE_UNPROVEN/缺观测。能力完备且证据 TRUE 的对照才可准入 |
| K13 空/缺测 | 住宅受体为空或观测缺失；存在义务/空集口径未解 | UNKNOWN，Mission 不 COMPLETE；明确允许空集与充分数据的对照按指定合同求值 |
| K14 密度高度 | 固定选区 built 人口密度阈值＋所有楼≤6层 | 两项独立；zone 档/缩分母不达标；一项缺测总完成 UNKNOWN |
| K15 紧凑低密 | 连续边界＋低密 hard，模板暗带高密下限 | 该模板不可用，不写 density floor；兼容模板正向保留两轴 |
| K16 组合 | 同网络同尺度纯 GRID 与 NOT GRID；对照不同尺度、ORGANIC residue | 首者 HARD_CONFLICT；后者不凭词面冲突拒绝，也不伪验收质性 |
| K17 财政 | FAST_EXPANSION＋禁止贷款，现金不足/足够两个世界 | 不借款；不足按资源阻塞；足够候选不被贷款策略否决 |
| K18 Profile 活性 | 现金足、合法虚拟候选、允许亏损、现在推进、Recovery soft 盈利门 | 输出合法集合并标 soft 让步；真正现金 hard 不足的对照仍阻塞 |
| K19 空地 | 指定已空土地 MAINTAIN vacant，另有人口目标 | 禁该地 infill；不拆残余建筑；其他有独立性证书的候选可准入 |
| K20 总完成 | required 原义/代理/开放维持/OPAQUE 混合，仅代理和一次测量满足 | 逐项报告，禁止总体 COMPLETE；有限 required 全证实的正向对照可以 COMPLETE，软审美未测须披露 |

另加承重事务 fixture：单 PATCH 同时撤旧禁令/加新无效 scope，必须整单拒绝、旧限制字节不变；同 update 重送不重建 baseline；独立硬保护不得随 target REPLACE 消失；geometry 不交但共享资源未知不得发独立性证书；完整不交且资源预留证实的别区候选必须允许，防止整单拒绝掩盖模型失败。

### 12.3 Metamorphic checks

对同一已绑定手写语义作子句排列、provider 标记、source 注释变换：规范化产物不变。改变 scope/极性/方面/owner 必须只改其语义影响域。无关 PATCH 保留等待、禁止贷款、baseline。明确将 grant 收窄必须不扩总权限；另加窄 grant 不等于撤原宽 grant。近似外观授权不传环境。输入世界/能力版本改变时结果可以变，但权限不得因能力升级扩大。将有效证据改缺测必须从 TRUE 变 UNKNOWN，不能保留旧 COMPLETE。

不把“工业远离住宅”和“住宅旁不放污染工业”强制作为同义 oracle；它们可能有不同限定。显式 revision 顺序不参与排列不变测试。

### 12.4 通过与失败口径

通过需所有红线 case 及正向对照同时满足 oracle；重复与排列测试得到相同规范化产物；没有自由语言解释依赖。报告必须保存 fixture、冻结 oracle、actual、版本和差异，不只报一个测试数。

任一出现即实验 FAIL：越权范围/方面，孤儿 grant，baseline 重捕获，取消旧目标复活，更新半接受，等待误解除，模板覆盖 hard，无独立证据先施工，缺证/代理假完成，Profile soft 静默永久 veto，或必须调用 AI 才能解释明确 typed 输入。若全部输入拒绝、正向局部例外或合法独立工作无法通过，也判 FAIL。

通过仅支持“这个有限 typed Compiler 契约存活”，不证明 arbitrary NL fidelity、全部 Ontology 覆盖、真实游戏可执行、100K 扩张玩法或生产可靠性。

## 13. 仍明确不支持的边界与能力缺口

T212 的重复人口阈值/累计触发、T370 的跨计划计数后保留哪两栋，本 V1 不提供执行语义：保留原义 residue＋明确 UNSUPPORTED；不能改成一次门或随意挑对象。任意自由谓词、云坐标、prefab 指定、施工序列、运行税/预算动作均 OUT_OF_BOUNDARY。玩家明确工程细节原文保留；只有当前已注册且无损的结果约束可执行，埋深/S 弯等不另开旁路。

Theme、交通线路、复杂曲线、污染/风水流、视廊、高度/FAR、增量维护成本、服务履约、provenance、隐式影响预检仍需真实能力证据；本轮不永久判游戏不可能，也不视作已经实现。无这些能力可如实拒绝相应兑现，有限 Compiler 实验不依赖它们实际存在。

V0 的原始五源 crosswalk、30 城市参照、T001–T370 分类账属于研究出处，本候选不复制为可执行规范；本文件已独立包含本轮实验所需全部语义规则和 oracle。未来 backend 增加映射须满足本文件契约，不得以研究例子反向改变类型语义。

## 14. 最终裁决

**READY_FOR_IMPLEMENTATION_FALSIFICATION**

SF02/03/05/07/09 的承重缺口及其余部分成立的问题，可以用稳定类型、显式规则裁剪、声明存续、原子更新、有限影响/独立性证明、效果合并与完成量化契约关闭，无需扩大架构或 Ontology。未解决的真实游戏能力与自然语言保真不妨碍先证伪这个有限 typed 核心；它们也没有被本裁决提前判 PASS。

第一轮只允许 hand-authored MayorIntent 与合成 fixture。当前授权止于这份候选规范交付；没有开始开发、连接前端或施工。候选应在该证伪实验之后再决定是否生产冻结。

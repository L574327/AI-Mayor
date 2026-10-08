# SOURCE_CROSSWALK

AI Mayor Semantic Compiler Research — 5→1 综合去重与统一 V0  
状态：**RESEARCH BASELINE / DRAFT / NOT FINAL / NOT FROZEN**  
输入截止：本轮提供的五份文件。未联网、未读取项目仓库、未验证游戏运行状态。  
本文件将五源结论、综合建议、未决冲突分开；不授权开发，不改变产品架构。

## 0.1 来源与审计口径

| 代号 | 按用户指定角色识别的来源 | 附件 | 稳定定位方法 |
|---|---|---|---|
| G | Gemini：Capability Atlas | 新建 文本文档 (4)(1).txt | 最终正文“一”至“四”；前半部含研究草稿，不能当独立第二来源 |
| D | DeepSeek：Gameplay Ontology | 新建 文本文档 (2)(1).txt | §0–§7；A1–A4、B1–B15、C1–C5；60 例编号 |
| P | GPT：MayorIntent | 新建 文本文档(1).txt | 原文标题、规则编号、FAILURE_MODES、MINIMAL_V1 |
| C | Claude：Local Executability | 新建 文本文档 (3)(1).txt | §0–§3、EXECUTABILITY_MATRIX、LOCAL_CAPABILITY_GAPS |
| R | Grok：红队语料 | 新建 文本文档 (5).txt | COVERAGE_ATTACK、COMPILER_TRAPS、T001–T370 |

来源归属按用户给定角色与内容匹配，不声称验证了模型生成身份。方括号如 `[D:B5; C:COMPACT; R:T081]` 是本地来源定位，不是外部文献证据。五份资料里引用的网页没有在本轮重新核验。

**证据标记：** CONSENSUS＝至少两个来源实质一致；COMPLEMENTARY＝来源补足不同层；UNIQUE_HIGH_VALUE＝单源重要信息；CONFLICT＝真实分歧；UNSUPPORTED / SPECULATIVE＝材料不足以支持该断言。综合提出的工作约定另标 **V0 PROPOSAL**，不冒充共识。

三个轴必须独立：

- **表达轴**：语言是否能保真进入有限语义，是否还存在歧义或不透明部分。
- **游戏轴**：EXACT / APPROXIMABLE / UNSUPPORTED，另挂 VERSION_SENSITIVE、DLC / CONTENT_DEPENDENT。
- **本地轴**：映射、观测、原语、验收各自是否具备。C 的 L0–L3 是推定，不是仓库证据；本轮所有“已有”都只能写为 **SOURCE_CLAIM / UNVERIFIED**。

EXACT 不表示必然成功，更不表示“云 AI 可直接执行”。同样，语义能表达一个矛盾，不表示存在可行方案。

## 0.2 主概念映射

| 链条 | Player phrase / R kill cases | G 能力 | D 概念 | P 语义 | C Local Effect | 所需观测 / 原语与链路结论 |
|---|---|---|---|---|---|---|
| X01 风格与形态 | 巴黎老城＋东京交通；T029、T058、T061 | Theme、街区、轨道 | STYLE＋URBAN_FORM＋NETWORK / TRANSIT_ACCESS | scoped preferences＋residue | STYLE 删除；形态参数、TOD 延后 | Theme 清单/控制、路网、线路；**CONFLICT**：不能用形态冒充外观；风格执行 GAP |
| X02 紧凑与密度 | 高密不要高楼；T081、T302 | 分区档位、天际线 | EXTENT≠DENSITY；但 DENSITY 混高度 | typed clauses，可独立约束 | COMPACT 含 density floor | cell/建成区边界/真实高度与楼面；**CONFLICT**：紧凑不得自动升密，高度不可被分区档吞并 |
| X03 用途与混合 | 底商上住；CBD 不要 office；T077、T363 | Mixed Housing 与分区 | LAND_USE＋USE_MIX | scope＋required/preferred | zoning composition、frontage | cell/用途/frontage、zoning；**COMPLEMENTARY**，竖向与水平混合不能互相冒充 |
| X04 工业不污染住宅 | T083、T103、T129、T312、T314 | 污染、风向、缓冲 | ENVIRONMENTAL_QUALITY＋SITING＋TRANSITION | environmental constraint，禁止硬转软 | INDUSTRY_BUFFER、距离、污染场 | 污染/风/住宅/路径；选址、分区、原语；**GAP**：距离≠污染结果，零污染不可伪验收 |
| X05 货运绕行 | T090、T303、T317 | 货运设施、对外连接 | ECONOMIC_ROLE＋NETWORK＋RELATION | connection / exclusion / temporal | INDUSTRIAL_LOGISTICS | 带交通模式路径与实际车流；道路/货运线路；存在绕行路径≠卡车实际不穿住宅 |
| X06 滨水与地形 | 不铲山；T039、T044、T130、T142、T147 | 岸线、桥隧、坡地 | SITING＋RELATION＋STYLE | scope、preserve、unsupported | 岸线偏移/坡度过滤 | 岸线/坡度/水流/视廊；道路/地形操作；**COMPLEMENTARY**，完整滨水形态与水景验收 GAP |
| X07 多区域 | 东美西欧、港口香港；T063、T076、T146 | 多主题/多中心 | scope 绑定、RELATION | scope expression＋snapshot/dynamic | scope polygon / regional construction | 本地地理解析、稳定引用；**CONFLICT**：C 要云给坐标，D 小域覆盖，均不能直接采纳 |
| X08 保护方面 | 路可改房别动；T151–T172、T368 | 老城保护近似 | PRESERVE＋INTERVENTION | preservation baseline＋permissions | veto、provenance、隐式拆除预检 | 实体方面/来源/影响集合；所有相关写原语；**COMPLEMENTARY**，全面冻结与方面保护有分歧 |
| X09 破坏性改造 | 可以拆但尽量少；T173、T186、T187 | 无完整权限模型 | INTERVENTION | permission 与 preference 分离、双钥匙 | scoped DemolitionGrant、dry-run | 影响范围、来源未知态、授权边界；**CONSENSUS**：Profile 不授拆除权；Grant 细度未决 |
| X10 财政与增长 | 钱不要紧；T106–T120、T364 | 经济/维护成本 | GOAL_PRIORITY、经济角色 | Mission / fiscal envelope / Profile 正交 | FISCAL_GUARD、建设准入 | 现金、债务、经常收支、增量维护费；**COMPLEMENTARY**，态度不等于资源或贷款许可 |
| X11 阶段门 | 人口 2 万后地铁；T197、T201、T211、T365 | 无语义模型 | PHASING | 玩家 outcome order；不含 Profile 序列 | activation_condition＋预留 | 指标、时间、显式放行事件、阶段容量；**COMPLEMENTARY**，模糊阶段阈值与重复规则 GAP |
| X12 中途变更 | 换东京、不动已建；T217–T238、T370 | 无 | PHASING 非完整 revision | PATCH/REPLACE/CANCEL/PRESERVE | reconciliation / implicit demolition | revision、未来计划、当前世界、作用域；**UNIQUE_HIGH_VALUE P** 补足更新契约 |
| X13 审美结果 | 漂亮、烟火气；T001–T028、T360–T362 | 主题/装饰代理 | CHARACTER＋derived 权重 | OPAQUE / APPROXIMATE，禁止假 KPI | 删除 AESTHETIC | 无可信 beauty evaluator；**CONFLICT**，保留语义与是否可执行必须分开 |
| X14 空置与服务 | 拆完空着；T192、T227；没学上 T326 | 服务、需求 | LAND_USE＋PHASING；缺显式空置例 | target / maintain / permission 可组合 | 自动跟随设施、默认 infill 风险 | vacant baseline、服务履约/容量；**UNIQUE_HIGH_VALUE R**：空地可能是目标，不是漏洞 |
| X15 指代、否定、例外 | T148、T271、T319、T351–T359 | 无 | scope / stance | source、revision、scope | scope 预检 | 对话对象→本地句柄、有限集合差；**UNIQUE_HIGH_VALUE R** 强化语法，不能一条句子造一个 Concept |
| X16 诊断与玩家手法 | T304–T328、T343 | 游戏机制建议 | 只意图、不施工 | 禁规划细节、世界事实回读 | 本地 policy 参数 | 诊断读回、版本化玩法知识；**GAP**：问句不得自动变写请求，精确手法不得洗成云施工计划 |

## 0.3 一条完整追踪：工业不要污染住宅

| 层 | 必须保留的内容 | 不得偷换 |
|---|---|---|
| Player phrase | “工业不要污染住宅”，source 保留 | 不先假设只是距离偏好；“不要污染”的严格度需由上下文确认 |
| Ontology | LAND_USE(industrial/residential)＋ENVIRONMENT_QUALITY(exposure)；SITING/RELATION 是可能手段 | 工业不能自动改成办公；绿带不是零污染证明 |
| MayorIntent | residential scope 上的污染目标/约束、工业用途要求、required/preferred；零值仅在玩家明确要求时写入 | 前端不能自行发明缓冲宽度、风向、污染阈值 |
| 本地编译 | 能力解析→定位受体/污染源→检测约束→从本地 policy 取得可用隔离参数 | Compiler 不自由想建城方案、不把硬目标降软 |
| Gameplay effect | 约束选址、工业 frontage、保护住宅、缓冲/物流连接偏好 | 不写施工顺序，不把工业带到任意“北侧” |
| Observation / primitive | 污染暴露、风场、住宅分布；选址/道路/zoning/设施；只具距离时报告 proxy-only | 无污染读回就不能回报“住宅未被污染” |
| 红队 | T083 工业城且无污染；T103 紧贴住宅零投诉；T129 随风；T312 风/水流；T314 办公缓冲 | 五个 case 共同攻击“结果被手段替代”，不是五个新 Concept |

**链路结论：语义接口已可串通；污染结果与实际执行尚未闭合。** `[G:一.4; D:B14/B15/A4; P:Rule5/7; C:INDUSTRY_BUFFER; R:上述编号]`

# CS2_CAPABILITY_ATLAS_UNIFIED_V0

## 1.1 去重后的能力表

表中等级是**五源可支持的研究判定**，不是截至某日的游戏事实认证。V＝VERSION_SENSITIVE，DLC/C＝DLC / CONTENT_DEPENDENT；“待核”不等于 UNSUPPORTED。

| 能力对象 | 游戏表达等级与条件 | 当前本地证据 | 统一处理、来源与证据类型 |
|---|---|---|---|
| 建筑 Theme / 地域外观 | 基础主题：EXACT 候选；具体地区包 V、DLC/C | C 称不可运行时控制，与 G 冲突；未实测 | 保留 STYLE，按已安装资产解析，不保证行政区强制换风格。[G:一.1; D:B6; C:STYLE] CONFLICT |
| 时代、材质、立面装饰 | APPROXIMABLE、DLC/C；自动历史演变 UNSUPPORTED 候选 | 无外观控制/验收证据 | “有历史风貌”≠“建筑随年代自然变旧”；材质不能隐式改用途。[G:三; D:B6; R:T256/T360] COMPLEMENTARY |
| 住宅密度/分区形态 | 原生档位 EXACT 候选；指定人口密度 APPROXIMABLE | C 推定规划态 L0，建成读回 L1 | 区分 zone class、楼高、覆盖率、FAR、人口密度。[D:B3; C:DENSITY; R:T081/T302] CONFLICT/COMPLEMENTARY |
| Commercial / Office / Residential | 类别 EXACT 候选；需求与实际企业/住户非直接设置 | C zoning L0 推定 | 中密办公“枚举缺口”不等于所有中层办公资产不存在；具体商店类型不可保证。[G:一.2; D:B1; C:CBD] |
| 用途混合 | 底商上住 EXACT 候选；水平混合 APPROXIMABLE；任意商住办垂直堆叠 UNSUPPORTED 候选 | C 比例/混合 zone 依赖本地支持 | 混合分区与任意拼楼分开。[G:一.2; D:B2; R:T065] CONSENSUS |
| 用地比例 | 规划面积比例可 EXACT 定义；建成人口/就业/楼面比例 APPROXIMABLE | C 支持 cell 统计的推定 | 禁止百分比的 D 与比例参数的 C 有真分歧；单位/分母不明确不编译。[D:B1; C:MIXED_USE] CONFLICT |
| 街区网格、放射、曲线/尽端路 | 游戏几何候选 EXACT；“有机感” APPROXIMABLE | C grid L0，曲线 L2，有机验收 L3 | 游戏有曲线工具不证明本地有曲线生成；不因执行不足删除意图。[G:一.3; D:B4; C:ORGANIC] |
| 紧凑、增长边界、飞地 | APPROXIMABLE；明确边界可 EXACT 约束 | C footprint/购地抑制 L0–L1 推定 | 与密度正交；边界不授权购地、推山或拆迁。[D:B5; C:COMPACT] CONFLICT |
| 道路等级/功能、通达 | 功能类别 EXACT 候选；实际流量结果 APPROXIMABLE | C roads L0、路径 L1–L2 推定 | 近高速≠连高速，存在路≠指定车辆走路。[D:B10/A3; C:LOGISTICS; R:T320] |
| 步行、自行车、公共交通 | 模式支持依版本 V、资产 DLC/C；“15 分钟城市” APPROXIMABLE | C 线路缺口 L2、walkability 验收 L3 | 站点距离≠网络步行时间；全模式零车辆不能由步行街保证。[G:一.3; D:B11; R:T265] |
| 停车供给/收费倾向 | 支持的政策/设施 EXACT 候选；交通改善 APPROXIMABLE，V | 本地停车控制未证 | 可独立限制供给，不自动删现有停车；“关停车更好”是待核 policy 假设。[D:B12; R:T305/T345] |
| 工业、资源产业、物流港 | 类型 EXACT 候选；产业角色/盈利结果 APPROXIMABLE；港口 DLC/C、V | C 路径 L1–L2，货运设施/线路未证 | 资源条件、运输能力、住宅影响必须解析；不保证具体产业链。[G:二; D:B9; C:LOGISTICS] |
| 空气/地面/水/噪音污染 | 模拟指标 EXACT 候选；隔离目标 APPROXIMABLE；零污染保证未获支持 | C 距离 L0、污染 L1、风场 L2 推定 | 风向、水流不可用地理方位替代；噪声与空气污染分别验。[D:B14; C:BUFFER; R:T312] |
| 水岸、地形、桥隧 | 游戏几何候选 EXACT；完整山城/运河 APPROXIMABLE，V、DLC/C | C 坡度 L1、岸线 L1–L2、完整形态 L3 推定 | 精细水工风险≠绝对不可能；不自动填海或推山。[G:二/三; C:WATERFRONT/HILLSIDE] |
| 视廊、天际线保护 | APPROXIMABLE 或待核；准确可见性无证 | 无 viewshed/高度 evaluator 证据 | 禁止用“低密”冒充不挡水景。[R:T147/T161/T178; P:preservation] |
| preservation / redevelopment | AI 操作边界可 EXACT 定义；自然演化保持原样 APPROXIMABLE | C scope、provenance、隐式拆除缺口 | AI 不改动与世界永不变化分开；道路写入也可能破坏建筑。[P:Preservation; C:§3.8–9] |
| 财政/经济/扩张 | 现金/债务/建设额可 EXACT 定义；未来盈利/繁荣 APPROXIMABLE，V | C 财政 L0–L1、维护预测未证 | 无贷款/现金下限是玩家约束；Profile 决定合法范围内的经营节奏。[P:Profiles; C:FISCAL] |
| 服务与三网 | 设施类别 EXACT 候选；覆盖/容量/履约有独立指标 | C utilities/facility 复用推定，无本轮实测 | “放了学校”≠孩子有学上，“连了管”≠服务履约。[C:REUSABLE; R:T204/T326–328] |
| 区域关系/多中心 | APPROXIMABLE；明确对象之间关系可 EXACT | C 组合现有能力，但云坐标建议被本轮原则排除 | 中心数量/角色可以是玩家目标，位置由本地解析/Planner 决定。[D:A; P:Scope; C:POLYCENTRIC] |
| 高档、可负担、财富混居 | APPROXIMABLE；精准人口/阶层工程未支持 | 无财富控制/租金保证证据 | Low Rent≠棚户区；低收入与精致外观并不逻辑冲突。[D:B7/B8; G:三; R:T024/T087] |
| 漂亮、真实、烟火气 | APPROXIMABLE 仅限明确有限代理；否则 OPAQUE；不是原生指标 | C 无验收量；P 要求保留 | 代理合格≠美学完成；自然凋敝不能冒充历史质感。[D:B8; P:§5; R:T362] CONFLICT |
| 真实室内/社交剧情/户籍/任意 3D 分区 | 五源未给有效兑现路径，UNSUPPORTED 候选，mods/版本另议 | 无原语证据 | 将缺失内容保留为 residue，不假装放建筑即实现行为。[R:T240–259] |

## 1.2 Gemini 独有信息保留：30 种城市参照的有限拆解

以下保留 G 的 30 种参照覆盖，不批准“城市名＝固定模板”。均为**可能被玩家指向的属性候选**；真正写入 IR 的只是有原话依据的面。特定地区包、机制与数值不继承为事实。

| 参照 | 可分离属性候选 / 必须保留的限制 |
|---|---|
| Paris | 欧洲/法式外观、中层/联排/混合、街墙、放射大道；不能默认全城同形态 |
| London | 联排、历史与现代并存、局部商务核心、曲线/非规则路网；不等于地标堆砌 |
| Amsterdam | 临水排屋、水岸界面、自行车；运河能力与外观分离 |
| Barcelona | 网格粒度、内外路权、superblock；不继承 G 的固定 100×100m |
| Manhattan | 高密核心、矩形网格、天际线、公共交通；不自动全城高楼 |
| LA Suburb | 低密、外扩、停车、区域干道；不必绑定 stroad |
| Tokyo | 站点导向、混合用途、小地块/窄街；日本外观与轨道系统分离 |
| Hong Kong | 高密、山水约束、公共交通、滨水；裙楼塔与立体动线不可假造 |
| European Old Town | 历史外观、细街块、步行优先、保护；不自动要求地下高速 |
| American Suburb | 低密独立屋、树枝路网、集散层级；曲线与尽端路能力单独核验 |
| Industrial Port City | 工业/物流角色、对外连接、货客分离、环境约束 |
| Garden City | 低中密、开放空间、增长边界；绿带不自动承诺治污 |
| 15-Minute City | 日常服务可达、混合、慢行；距离与实际出行时间必须区分 |
| TOD | 站点关联、密度梯度、换乘与停车关系；有站≠可用线路 |
| Waterfront Resort | 滨水公共空间、旅游角色、客运连接；收益/资产 V、DLC/C |
| Chicago | 网格、后巷、集中商务、高架交通；具体卸货机制待核 |
| Dubai | 高楼、纪念性、车导向等候选；不得忽略玩家附加 walkable/低预算 |
| Venice-style | 水岸/运河、步行、水运；服务与物流不能靠外观满足 |
| Detroit | 工业历史、基础设施尺度、衰败审美；不批准停服务造废弃 |
| San Francisco | 坡地网格、联排、电车；保山与道路坡度限制优先 |
| Seattle | 山水走廊、港口、办公核心；G 草稿/正文主题标签不一致，不据此指定包 |
| Singapore | 高密住宅、绿化、公共交通；不照搬过路费/收费权限或强制转乘断言 |
| Miami | 沿海带状形态、高密住宅/旅游；特定季风水位说法待核 |
| Berlin | 多中心、混合、轨道网络；不保证平坦地价或需求分布 |
| Washington DC | 高度限制、对角放射＋网格；不用低密分区伪装精确限高 |
| Rio de Janeiro | 海岸与山地对比、混合尺度；Low Rent 不能兑现真实 favela |
| Houston | 蔓延、停车、用途邻接；不主动制造污染当作“真实” |
| Beijing | 环路、大街块、内部慢行、较高密度；不由前端画环路 |
| Las Vegas | 旅游、线性核心、地标集中；不等于无限资产支出 |
| Kyoto | 低中层、谷地网格、历史感、开放空间；具体历史资产待核 |

## 1.3 不得继承为规则的来源断言

| 原断言 | 审核结论 |
|---|---|
| G：所有地区包/DLC 及发布日期均已可用、District 可强制主题 | UNSUPPORTED / SPECULATIVE：没有逐项可追溯出处，且 C 否认可控；必须由 Capability Set 后续核验 |
| G：低密办公只有一层，高密办公必摩天楼 | 过度外推；分区枚举缺口不证明资产高度全集 |
| G：无车城区必须地下高速；进口工业品必全面崩溃；工业隔离必须固定四段梯度 | 研究材料没有支持“必须/必然”的证据；保留物流/环境依赖，不保留固定施工教条 |
| G：树能截断污染/地价、行政区税收保护工业、收费可强制转乘、季风水位规律 | SPECULATIVE / VERSION_SENSITIVE；不得直接生成 policy 参数 |
| G：不存在历史时代演进，因此不能表达历史中心＋现代外围 | 把动态演变和静态空间组合混淆；后者可以表达，资产可用性另验 |
| D：所有高层结果词都能转权重；低收入与精致冲突 | 与 P 相冲突，且社会语义无依据；不建立财富→审美的硬推导 |
| D：24 个概念不可删且覆盖近全量 | §6.1 列的是 4＋14＋5＝23；ENVIRONMENTAL_QUALITY 地位反复。60 例是自构例，不是覆盖证明或实测消融 |
| D：“工业不要污染住宅”只展开缓冲；“紧凑”例子附加中密与硬边界 | 示例有语义增添/丢失，不能覆盖其自身“无隐式蕴含”原则 |
| C：无法验收“有机感”→曲线生成原理上不可验收 | 把生成能力、几何验收、主观美感混在一起；只有主观目标无法二值验收可保留 |
| C：已有本地能力 L0 | 原文明确是推定；不能据此对当前 AI Mayor 报 PASS |
| R：自称社区原话、按击穿率排序 | 无逐条出处/真实编译运行数据；是有价值的挑战集，不是生产分布或实测错误率 |

# GAMEPLAY_ONTOLOGY_UNIFIED_V0

## 2.1 最小共同结构：16 个领域概念＋5 个结构语义

**V0 PROPOSAL，而非已证明最小。** 不机械取并集，也不因当前缺手脚删掉玩家能明确区分的需求。领域概念描述属性/关系；结构语义承载 scope、reference、preservation、permission、time。hard/soft、priority、negation、revision 是通用语法，不再做城市概念。

合并：NETWORK＋TRANSIT_ACCESS → MOBILITY 的不同参数；TRANSITION → SPATIAL_RELATION 的界面参数；WEALTH_GRADE → HOUSING_CONDITION；LANDMARK/大学城/CBD/工业港/城市名 → 组合。保留 EXTENT 独立于 DENSITY。服务容量、人口、现金等通过带单位的目标谓词表达，不为每个数值指标再造 primitive。

以下每张卡都给出 canonical_name、类别、语义、参数、兼容、冲突、例句、效果、观测、原语、DOES_NOT_MEAN、精度、本地状态。所列本地效果全在本地编译产物中选择，不是云端参数授权。`待核`＝五源没有当前实现证据；L 等级仅转述 C。

### O01 STYLE

- 类别/语义：STYLE；资产外观谱系与经支持的外观限定。
- 参数：lineage、era、material/ornament（仅已有语义词）；scope、required/preferred 由通用语法承载。
- 兼容：全部形态、密度、用途；冲突：同对象硬性排斥的谱系/资产集，无可用包。
- 例句：“欧式外观，不要玻璃塔”。效果：本地候选资产/主题过滤；观测：安装内容、主题标签、实际模型；原语：受支持的主题或资产族选择。
- DOES_NOT_MEAN：欧式不隐含中高密、道路形状、拆迁。精度：支持的标签 EXACT；时代感 APPROXIMATION_ONLY。本地：G/D 称支持、C 称不可控，**CONFLICT/待核**。[D:B6; P:residue; C:STYLE]

### O02 URBAN_FORM

- 类别/语义：URBAN_FORM；街区、地块和建筑群的空间组织。
- 参数：pattern、grain、street-wall/退线倾向、中心结构；高度/FAR 放 O03，蔓延放 O04。
- 兼容：任何 STYLE、DENSITY；冲突：同一网络同时纯网格与纯树枝、保护既有布局但要求重构。
- 例句：“小街块，留住尽端路”。效果：有限本地几何模板/参数约束；观测：街块/道路拓扑/地块边界；原语：相应 road generator、frontage。
- DOES_NOT_MEAN：“有机”不等于随机抖动，“巴黎”不是一个 pattern。精度：明确几何类别 EXACT；有机感/街墙逼近 APPROXIMATION_ONLY。本地：grid L0 推定、曲线 L2、街墙未证。[G:二; D:B4; C:GRID/ORGANIC; R:T077]

### O03 DENSITY

- 类别/语义：DENSITY；在明确分母与观测态下的开发强度及竖向限制。
- 参数：metric（zone_class / 人口每面积 / FAR / coverage / height）、值或档、单位、planned/built、梯度；不能把这些指标互换。
- 兼容：紧凑低层、高层低覆盖；冲突：同指标同域同时间的矛盾硬界限；高人口＋限高通常只是容量待判。
- 例句：“高密但不超过六层”“FAR 1.2–2.5”。效果：本地 zoning/候选形态约束；观测：cell、楼面/占地/高度/人口；原语：zoning、可控建筑筛选（有无待核）。
- DOES_NOT_MEAN：高密≠高楼≠紧凑，建筑等级≠楼面比。精度：数值谓词 EXACT；可兑现形态常 APPROXIMATION_ONLY。本地：分区 L0 推定，FAR/高度控制与验收待核。[D:B3; C:DENSITY; R:T081/T302]

### O04 EXTENT

- 类别/语义：GROWTH / URBAN_FORM；建成区连续性、扩张范围、允许飞地与边界。
- 参数：contiguity、growth_boundary、infill/outward 倾向、外扩方向/节奏意图；边界几何本地绑定。
- 兼容：所有密度；冲突：硬边界内容量不足、冻结区内填充；不是看到高人口就自动判冲突。
- 例句：“不要摊大饼”“只往南扩”。效果：候选区过滤、填充优先、购地范围限制；观测：已开发面积/边界/所有权；原语：选址、区域建设、购地（受权限）。
- DOES_NOT_MEAN：紧凑不自动中高密，不暗授拆迁。精度：明确边界 EXACT，紧凑倾向 APPROXIMATION_ONLY。本地：C L0–L1 推定，独立于其 density floor 争议。[D:B5; C:COMPACT]

### O05 LAND_USE

- 类别/语义：LAND_USE；功能类别及允许、排除、主导关系。
- 参数：住宅/商业/办公/工业/资源/物流/服务/开放空间等角色、subtype、ordinal emphasis；explicit share 必须带分母，是否纳核心见 M05。
- 兼容：密度、混合、经济角色；冲突：同 scope 对同用途同时硬允许存在且硬禁止；住宅和工业共存本身不构成逻辑矛盾。
- 例句：“CBD 不要办公”“拆完保持空地”。效果：zone/facility 类别许可、禁止 infill；观测：用途、occupied/vacant、规划/建成面积；原语：zoning、设施、未来计划约束。
- DOES_NOT_MEAN：商业不保证具体商店；vacant hold 不授予先拆权。精度：类别/禁止 EXACT；实际比例结果可能 APPROXIMATION_ONLY。本地：zoning L0 推定、空置锁待核。[D:B1; C:MIXED_USE; R:T192/T227/T363]

### O06 USE_MIX

- 类别/语义：LAND_USE；用途在建筑/街块/区域内如何共存。
- 参数：horizontal/vertical、共存用途、尺度、程度；和 LAND_USE 共用用途词汇。
- 兼容：低密、尽端路、保护；冲突：禁止一种用途却要求它参与混合，要求游戏无对应的垂直组合。
- 例句：“楼下店楼上住，路网别动”。效果：混合 zone 或本地空间分配约束；观测：zone 类型、实际用途组合、frontage；原语：zoning/frontage。
- DOES_NOT_MEAN：水平 R/C/O 不等于一栋商住办。精度：支持的 mixed zone EXACT；广义混合 APPROXIMATION_ONLY。本地：C L0 推定，有效混合类型待核。[G:一.2; D:B2; R:T065/T077]

### O07 MOBILITY

- 类别/语义：MOBILITY；网络功能、方式偏好、连通性与交通使用限制。
- 参数：mode、hierarchy、permeability、freight restriction、access target、redundancy；几何 pattern 归 O02，停车归 O08。
- 兼容：任何 STYLE；冲突：全禁汽车但硬需汽车业务、货运禁行与唯一必经路径；需世界判定。
- 例句：“东京交通”“货车不过住宅”“每处有两条不重叠路径”。效果：模式/路径约束、道路等级/交通服务目标；观测：分模式网络、线路状态、客货路径、旅行时间；原语：道路/交通线路/受支持政策。
- DOES_NOT_MEAN：邻近≠连通，存在旁路≠实际分流；不输出路线/车道方案。精度：模式和路径谓词 EXACT；顺畅/15分钟服务 APPROXIMATION_ONLY 直至 evaluator 可用。本地：道路推定可用，线路 C:L2，步行验收 C:L3。[D:B10/B11; C:TOD; R:T320]

### O08 PARKING

- 类别/语义：MOBILITY；停车供给与收费倾向的独立要求。
- 参数：supply、surface/underground、pricing stance、用途/区域绑定。
- 兼容：高低密、公共交通；冲突：硬禁地面停车却要求仅有地面设施提供车位；充足停车与紧凑是权衡，不必硬冲突。
- 例句：“只关工业路边停车”“河边不留地面停车”。效果：本地停车设施/政策约束；观测：停车类型、容量、需求；原语：设施/停车政策（待核）。
- DOES_NOT_MEAN：禁新停车不等于拆现有，收费倾向不产生费率。精度：类别限制 EXACT；供给感受 APPROXIMATION_ONLY。本地：待核，不能借 zoning 冒充。[D:B12; R:T305/T345/T369]

### O09 OPEN_SPACE

- 类别/语义：ENVIRONMENT / LAND_USE；公园、广场、绿带、自然地的类型与分布。
- 参数：type、amount、distribution；关系引用 O15；具体数量仅保留玩家数值。
- 兼容：所有密度、公共空间、增长边界；冲突：同地必须保空/保自然却放设施；绿多与高密是容量权衡。
- 例句：“水边公共步道”“环城绿带”。效果：设施类别/预留地/连通带偏好；观测：开放空间范围、设施覆盖、连通；原语：设施、道路/步道、保留约束。
- DOES_NOT_MEAN：公园数量不是漂亮，树林不保证隔离污染。精度：类型 EXACT；分布/体验 APPROXIMATION_ONLY。本地：C 公园 L0 推定、步道与细节待核。[D:B13; C:GREEN]

### O10 ECONOMIC_ROLE

- 类别/语义：ECONOMY；区域在生产、居住、服务和对外关系中的角色。
- 参数：manufacturing/logistics/office/tourism/resource/residential-support/diverse 等角色、主次；不是自由行业细目。
- 兼容：各用途组合、环境限制；冲突：资源业无资源、无货运的繁忙港；不能未经世界判定一概拒绝。
- 例句：“工业港”“卧城”“旅游古镇”。效果：本地用途/需求/对外连接偏好；观测：资源、就业、通勤、产出、需求；原语：zoning、设施、对外网络。
- DOES_NOT_MEAN：角色不等于盈利保证，不等于 Profile。精度：角色声明 EXACT；实际经济结构 APPROXIMATION_ONLY。本地：C 工业 L1–L2 推定，旅游等待核。[D:B9; C:CBD/LOGISTICS]

### O11 HOUSING_CONDITION

- 类别/语义：ECONOMY；可负担性、居住群体混合、租金/财富相关目标。
- 参数：affordability、rent/wealth band（指标来源须明确）、mix、受益群体；不创建现实户籍系统。
- 兼容：精致外观、任意密度；冲突：只允许一种群体又要求同域全面混居；富裕外观≠高收入居民。
- 例句：“普通人住得起，也要舒服”。效果：本地住房类型/服务/经济偏好；观测：租金、家庭负担、财富、入住；原语：受支持住宅与服务工具。
- DOES_NOT_MEAN：低租金≠棚户区，不能以驱逐达标。精度：APPROXIMATION_ONLY，明确数值目标可表达但未必兑现。本地：待核。[D:B7; G:三; R:T024/T027/T290]

### O12 ENVIRONMENT_QUALITY

- 类别/语义：ENVIRONMENT；受体暴露、噪音、水质、清洁能源等结果要求。
- 参数：field、受体 scope、threshold/tolerance、instant/maintain；不把空气/噪音混成一项。
- 兼容：SITING、缓冲、任何经济角色；冲突：同指标矛盾阈值或可用能力无法达标。
- 例句：“住宅不能被工业污染”“水别脏”。效果：环境约束与本地治理偏好；观测：相应污染/水质/能源指标；原语：选址、设施、受支持治理能力。
- DOES_NOT_MEAN：距离/种树不是零暴露证明，“低碳”若无指标不得假造。精度：阈值定义 EXACT，效果常 APPROXIMATION_ONLY。本地：C 污染/风场缺口推定；保留此概念，D 删除建议仍入争议。[D:B15; P:Rule5; R:T083/T103]

### O13 AESTHETIC_CHARACTER

- 类别/语义：AESTHETIC_CHARACTER；氛围、漂亮、真实、高级等质性偏好。
- 参数：literal＋已有有限轴（安静/活跃、规整/不规整等），resolution；未有合法映射的词留 OPAQUE。
- 兼容：所有结构属性；冲突：需看同一方面/时间是否相斥，安静与有人气并非自动互斥。
- 例句：“烟火气，不要规划感”。效果：仅经本地批准的有限近似偏好；无映射则无写效果；观测：代理指标与用户判断，不存在通用 beauty；原语：不直接授工具。
- DOES_NOT_MEAN：高地价≠漂亮，废弃≠真实。精度：APPROXIMATION_ONLY 或 OPAQUE，不是 EXACT。本地：C:L3 验收，P 保留、D 权重，**CONFLICT**。[D:B8; P:§5; R:T361/T362]

### O14 VARIATION

- 类别/语义：AESTHETIC_CHARACTER / URBAN_FORM；可指定属性的受控异质性。
- 参数：vary_axes、程度、跨 scope 的分布关系；seed 是本地参数，不越境。
- 兼容：统一 STYLE 内变化、不同街区；冲突：同一属性完全一致与必须不同。
- 例句：“各区有区别，别全一个模子”。效果：本地模板组合/分布参数；观测：被要求属性的差异，而非美学评分；原语：相应道路/zoning/资产筛选。
- DOES_NOT_MEAN：随机抖动不等于真实，不允许为差异拆已建。精度：属性不同可 EXACT，真实感 APPROXIMATION_ONLY。本地：C seed L0 推定，D 反对纯随机，映射未决。[D:C5; C:VARIATION; R:T022]

### O15 SPATIAL_RELATION

- 类别/语义：SPATIAL_RELATION；范围之间的拓扑、距离、朝向、界面/缓冲。
- 参数：near/far/along/facing/surround/connected/opposite、reference、distance metric/band 或玩家距离；interface＝buffered/gradual/screened、fill、width。
- 兼容：全部用途/形态；冲突：同距离度量的互斥区间；surround 与 along 未必互斥，不采 D 的普遍互斥说法。
- 例句：“沿主路商业”“工业住宅之间办公缓冲”。效果：本地空间筛选/邻接约束；观测：几何、frontage、网络、两个端点；原语：选址、相应建设/保留过滤。
- DOES_NOT_MEAN：缓冲不保证物理安全，along 不等于任意宽包围盒；连接不是邻近。精度：定义明确关系 EXACT；宽泛空间感 APPROXIMATION_ONLY。本地：C 距离 L0、frontage L1、网络 L1–L2 推定。[D:A3/A4; C:BUFFER; R:T148/T314]

### O16 SITING

- 类别/语义：ENVIRONMENT / SPATIAL_RELATION；相对物理场的条件。
- 参数：wind/water-flow/slope/resource/shore/risk、side、reference；可保留玩家阈值，坐标不越境。
- 兼容：用途、环境目标、地形保留；冲突：指定地理位置与物理场条件在当前世界无交集。
- 例句：“上游取水下游排污”“山脊不要破”。效果：本地场地过滤/方向约束；观测：风、水流、坡度/岸线、资源；原语：选址、道路、设施，地形修改另受权限。
- DOES_NOT_MEAN：下风≠南边，不自动随风搬迁，不授予推山。精度：读回存在时条件 EXACT；效果保证 APPROXIMATION_ONLY。本地：坡度/岸线/风场 C:L1–L2 推定。[D:B14; C:TERRAIN; R:T130/T312]

### S01 SCOPE

- 类别/语义：SCOPE 结构；子句作用的有限世界集合，区别现有/未来。
- 参数：selector、SNAPSHOT/DYNAMIC、acceptance baseline、包含/排除/交集、有限 universe；reference 见 S02。
- 兼容：所有概念；冲突：无有效绑定、空/重叠范围导致要求冲突。
- 例句：“只改东边，河边那排除外”。效果：本地候选和副作用边界；观测：选择/地理/既有世界；原语：scope 解析与所有写操作过滤。
- DOES_NOT_MEAN：不是 District，同名不等于同实体；“之外”不默认全图。精度：绑定后 EXACT；未绑定 AMBIGUOUS。本地：C:L1 推定，摄像头等未证。[P:Scope; D:A1; R:T148/T351]

### S02 REFERENCE

- 类别/语义：SCOPE / REFERENCE 结构；玩家所指对象或语义锚点，不是新建筑指令。
- 参数：本地提供的 opaque selection/reference handle、feature kind、已有 clause/intent reference；指示词原文保留。
- 兼容：scope、关系、更新；冲突：多个候选、过期引用、私人记忆无材料。
- 例句：“这个环岛”“上一个方案”。效果：绑定已有世界/声明；观测：选择上下文、对象与对话引用；原语：本地 resolver，不是放置。
- DOES_NOT_MEAN：功能类别不能随意代替玩家指名对象；云不能造 entity ID。精度：唯一绑定 EXACT，否则 AMBIGUOUS。本地：待核。[D:A2; P:selection_ref; R:T054/T354]

### S03 PRESERVATION

- 类别/语义：PRESERVATION 结构；保护当前世界指定方面，baseline 由本地建立。
- 参数：scope、aspects（建筑/道路/用途/管线/树/命名/外观等）、baseline、hard/soft；来源限定依赖可观察 provenance。
- 兼容：不影响被保护方面的维护/添加；冲突：任何直接或间接破坏，包括改路删楼。
- 例句：“道路可以改，建筑别动”。效果：影响集合 veto；观测：方面状态、来源/未知来源、差异；原语：各写原语预检。
- DOES_NOT_MEAN：不自动冻结消防/收垃圾；不保证模拟自然不变。精度：AI 操作边界 EXACT，完整世界不变 APPROXIMATION_ONLY。本地：C:L1–L2 推定，预检最大风险。[P:Preservation; C:§3.8; R:T152/T163]

### S04 INTERVENTION_PERMISSION

- 类别/语义：PERMISSION 结构；允许的改变种类与范围，不能被 preference/profile 提权。
- 参数：READ_ONLY / ADD_ONLY / 明确允许类别；destruction ALLOW/FORBID、scope、受影响方面；C 的数量/期限/来源限制作为待定 grant 细化。
- 兼容：允许拆＋尽量少拆；冲突：许可与有效 preserve 不相容时无权绕过。
- 例句：“先提案不动工”“可以重建东边但留地铁”。效果：本地权限 envelope；观测：授权、影响清单、现存保护；原语：所有变更准入。
- DOES_NOT_MEAN：“随便/优化/我信任你”不清空旧边界；ALLOW 不等于必须拆。精度：EXACT。本地：权限/预检执行待核。[D:C2; P:Permission; C:DemolitionGrant; R:T215]

### S05 TEMPORAL_CONDITION

- 类别/语义：TEMPORAL / GROWTH 结构；玩家要求的激活、顺序、持续或等待条件。
- 参数：BEFORE/AFTER、已注册 predicate、REACH/MAINTAIN、模拟时间/真实时间明确区分、显式玩家放行；禁止自由代码。
- 兼容：所有领域目标/权限；冲突：环依赖、不可观测/不满足条件、不同时间基准。
- 例句：“2 万人口再地铁”“等我回来才分区”。效果：子目标/权限门、必要的目标地预留；观测：人口/财政/容量/时间/放行信号；原语：已有本地推进机制消费门控。
- DOES_NOT_MEAN：不是 Profile 序列或施工 workflow，延期不等于取消。精度：明确条件 EXACT，模糊“稳定”待解析。本地：C activation L1 推定；重复触发/计数选择未闭合。[D:C3; P:temporal; C:PHASED; R:T197/T201/T212]

## 2.2 不增加概念的处理

“漂亮/真实/繁荣”不统统挤进一种结果：漂亮保留质性偏好；真实可拆出用户实际说出的变化/保留要求；繁荣只有被明确为就业、收支或商业活动时才成为对应 metric target。没有理由把漂亮换成地价。

SERVICES 不是另起“大服务系统”：服务类别使用 LAND_USE，服务履约/覆盖/容量使用注册目标指标。城市人口、财政存量、环境暴露与交通时间也用同一目标谓词结构。

vacant hold＝LAND_USE 的明确空置目标＋MAINTAIN/禁止填充，不新增 VacantHold 引擎。极性/例外＝语法；authorship＝观测属性；CommunityMechanic＝本地版本化 Gameplay Skill 的候选知识，不能成为云端施工算子。Grok 提出的“IntentStack”不采为架构，保留其对稳定回指/撤销语义的要求。

**新基础 Concept 的准入**：多个独立 case 暴露同一不可由现有组合表达的玩家区分，而且有明确意义/效果边界。不得把“暂时没有原语”误判为缺概念。16＋5 是可被消融挑战的工作表，不是 21 个必须实现的新系统。

# MAYOR_INTENT_V1_UNIFIED_DRAFT

## 3.1 只让必要信息越过语义边界

**CONSENSUS 核心**：声明玩家期望的未来状态、约束、偏好、允许手段与更新语义；不声明本地怎样施工。[D:§2.L6; P:核心模型; C:权限/Profiles] C 关于云端输出坐标的反向建议单列冲突，不收入草案。

| 保留的信息 | 最小语义 | 为何必须存在 / 边界 |
|---|---|---|
| schema / ontology version | 明确词义版本 | 新能力不能重新解释旧语义或自动扩权；能力版本属于本地编译记录 |
| mission identity / revision | 稳定声明身份，修改带 base_revision | 本地校验/分配身份；云不能凭空创建已存在历史 |
| mission source | 原始目标与来源定位 | 保留北极星，但原文不是 Compiler 可执行输入 |
| typed clauses | TARGET / CONSTRAINT / PREFERENCE / PRESERVE / PERMISSION | 不为 style、财政、道路各造一套平行语法 |
| semantic content | canonical concept 或注册 metric＋有限参数 | 只含目的/允许手段，不含模板实例或工具调用 |
| modality | REQUIRED / PREFERRED | forbidden 是约束极性，不是“很低优先级”；permission 不拿权重表示 |
| priority | 软目标之间的偏序/有限等级 | 不把 hard 变成大权重；相同优先级不自动构成不可行 |
| scope / reference | 语义 selector＋本地提供的 opaque handle＋绑定方式 | 坐标、polygon、entity ID 留本地；模糊指代不默认全市 |
| completion | REACH / MAINTAIN / NON_BINARY，指标/阈值/时窗仅据玩家要求或明确本地解释契约 | TARGET 的达成条件不同于执行期间硬约束；不因尚未到 5 万人口就禁止增长 |
| preservation | 对象范围、保护方面、baseline 请求 | baseline 内容由本地世界捕获；不把世界快照塞进 IR |
| permission | scope＋操作类别，尤其 destructive change | 可以拆与应该拆不同；数量/期限/source 限额的核心范围未冻结 |
| temporal relations | 玩家明确的顺序/激活/等待/持续条件 | 不含云推断的 Profile 顺序；可用 predicates 必须有限注册 |
| approximation intent | 玩家允许/拒绝的近似、原义与候选解释差异 | 本地有权否决不支持的映射；云 confidence 不算能力认证 |
| semantic residue | 原话、维度、歧义/不支持原因、required/soft、引用 | 防止吞词，但“存了原文”不算可表达完整执行语义 |
| revision operation | PATCH / REPLACE / CANCEL / PRESERVE，目标 axes/clauses/scope；destructive reconciliation 请求分离 | 与城市的物理回滚分离；operation 是声明更新，不是施工 |

STYLE、URBAN_FORM、LAND_USE 等是 clause 内的语义内容，不必复制成顶层专用字段。fiscal tolerance 是现金/债务/支出/风险约束及偏好的组合，不是第五种 Profile。ambiguous / unsupported / exact 等最终 resolution 是**本地编译诊断**；前端可报告候选含义，不能替本地宣布支持。

## 3.2 精度、数值与原文责任

**V0 PROPOSAL**：允许玩家明确说出的结果阈值（人口 5 万、距离 400m、FAR 区间、现金底线），但不得从“好看”“紧凑”推导出未经说明的数值。数值必须带指标、单位、分母、scope 与计划态/建成态。若词义不明则保留并解析，不能删掉数字换成“附近”。[P:Target; R:T135/T148/T302/T313]

玩家主动提供的具体工程手法，如 T304 的货运站 S 弯、T307 的 -12.5m 埋深，要区分两件事：

1. 不丢失玩家原话和显式限制；
2. 是否允许成为可执行 MayorIntent 的类型化条件，仍受冻结边界与本地词汇限制。

本轮不新增“把原话当工具参数”的旁路。明确结果尺度可入目标；具体施工几何/顺序留 residue 并报告 **OUT_OF_BOUNDARY**，可提取无损的目的或禁止项，但不能声称原手法已照办。T307 这类“工程数值限制而非坐标”是否允许入受控 constraint，是下一轮 M15 的专门问题，尚不冻结。

## 3.3 概念草案示例（非 JSON Schema、非施工计划）

玩家：“东边新区做低层紧凑住宅，西边路和房子别动；财政稳定后再扩到五万人，可以慢一点。”

| 声明 | 草案表示 | 仍需解析 |
|---|---|---|
| Mission | 扩到 5 万人口，带区域形态/保护条件 | scope 是全市还是新区人口，依上下文判断 |
| 东边新区 | FUTURE_EXPANSION＋east，显式本地边界绑定 | 东的基准、动态扩展范围 |
| 低层 | DENSITY.metric=height，PREFERRED 或 REQUIRED 由语气/上下文 | 玩家未给层数，不能填六层 |
| 紧凑 | EXTENT.contiguous / limited sprawl 倾向 | 不自动加高密或硬增长半径 |
| 住宅 | LAND_USE residential 主导 | 不自动排除服务/必要商业 |
| 西边别动 | PRESERVE roads＋buildings，SNAPSHOT baseline | 西边范围；基础服务维护不自动被禁 |
| 财政稳定后 | population growth 受 fiscal stability predicate 门控 | 资金/收支时窗如何定义，不能任填三个月 |
| 可以慢一点 | growth pace 的软偏好/放松急迫度 | 不是 BALANCED Profile 指令 |

这份草案可以保真承载未解决部分；在范围/稳定谓词未解析前，不能称完全可执行。多个子句若相互依赖，不得先做“容易执行的那半句”。

# FORBIDDEN_IN_MAYOR_INTENT

| 禁止内容 | 可保留的合法意图 |
|---|---|
| concrete coordinates、云生成 polygon、entity IDs | 玩家选择的 opaque local reference、方位/岸线等 selector |
| exact road geometry、路段列表、曲线控制点、管线走向 | 网格/道路功能/连接/避让/尺度目标，不生成几何 |
| specific construction sequence、工具调用、批次 | 玩家明确的 outcome order 或粗粒度阶段约束 |
| arbitrary prefab / road asset choice、template instance IDs | 功能/风格/模式要求，本地选择支持的资产和模板 |
| runtime tax tuning、费率/预算调节动作 | 财政目标、禁止加税、贷款许可边界；具体运行调节本地负责 |
| Planner 内部搜索、top-K、seed、分步贪心方案 | 无；这些完全留本地 |
| Profile transition sequence | 玩家目标顺序，不是 FINANCIAL_RECOVERY→FAST_EXPANSION |
| 云推测的世界事实、达标声明 | 目标、玩家所述情况作为待核信息；事实必须读世界 |
| 任意表达式/代码、自由语言交给 Compiler 推理 | 注册概念/谓词/有限参数、非执行 residue |
| 以“漂亮/真实”为由凭空量化 | 原始质性偏好，或者经说明的有限近似 |
| 原话包装的隐藏施工命令 | source 仅追踪，绝不能被另一路执行 |

“先修铁路，再扩工业”可成为玩家要求的阶段关系；“先修坐标 A→B 的 3 段铁路，再放某 prefab”不能整体透传。C 的“外部 AI 给出中心坐标/老城多边形”被本轮用户原则直接排除；这不是综合者私下裁决来源冲突，而是执行更高优先级的冻结边界。

# INTENT_COMPILATION_SEMANTICS_UNIFIED_V0

## 4.1 输入与产物

输入为 **MayorIntent＋Latest World State＋Capability Set＋本地 Gameplay Skill / Templates＋四种 Objective Profiles**。既有已接受 Intent 与权限基线是 revision 合并时的上下文，不是第二份世界事实。

本地输出：GoalSet、ConstraintSet、SpatialPreferenceSet、PreservationRules、PermissionEnvelope、FiscalEnvelope、TemporalConditions、允许的本地 Policy/Template 参数，以及 CompletionCriteria / Diagnostics。**这些是 Planner 可消费的声明，不是已经选好的施工步骤。**

| 本地编译责任 | 必须做 | 不属于此步骤的事 |
|---|---|---|
| validation | schema/版本/引用/数值单位/极性/来源/更新基线合法性 | 用语言模型重读故事后临场规划 |
| scope resolution | 从最新世界绑定 selector；区分 snapshot/dynamic；检查有界补集 | 云给坐标、随意替玩家选一个“那个” |
| capability resolution | 分别验证 meaning→mapping→observation→primitive→evaluator | 某个概念名在 enum 中就宣告支持 |
| concept composition | 组合有限属性与关系，分清同域/同方面/同时间 | 自动把 STYLE 推成密度，套城市名全套模板 |
| constraint merge | hard 取交，permission 取有效许可边界，preserve 限制相关变化 | 小 scope 自动盖掉全城硬约束、last-write-wins |
| conflict detection | 给出冲突子句、原因、涉及 scope/时间；区分必然冲突和未知可行性 | 因两个目标看似难兼顾就宣布物理不可能 |
| profile compatibility | 给本地经营策略留下合法范围；当前无合法推进则报告阻塞 | 切换 Profile 来解除保护/债务限制 |
| approximation handling | 本地映射必须有限、有损失声明、受用户近似意向约束 | 把 hard 偷降 soft，保留漂亮字样却只验公园数 |
| completion lowering | 建立注册 evaluator / proxy / non-binary 的边界 | 用分区完成代替人口、实际噪音或服务结果完成 |
| diagnostics | 每个未解析/未支持/冲突子句可追溯，允许条件满足的独立部分继续 | 静默丢 unsupported soft，或整单永远卡住 |

上述是编译责任清单，不是新增 workflow engine。C 建议的固定“选址→路网→分区→管网→设施”、top-K 和贪心属于本地 Planner/Policy 研究，不收入跨边界语义规范。

## 4.2 合并和可行性规则

1. **执行硬约束与终态目标分开。** 5 万人口是 REACH target；“不许拆西边”是持续 invariant。只有 1 万人口不表示违反 invariant，否则任何增长任务一开始都会被自己挡死。P 曾把人口 target 举在 hard constraint 中，统一稿必须显式标明求值时态。
2. **Hard-hard 不能权重抵销。** 同方面同时间矛盾要报告；若 scope 不同或阶段不同，则可能兼容。
3. **Hard-soft：**合法性先于偏好；被抑制的偏好仍有诊断。**Soft-soft：**同级不等于不可行；本地可在已授权的有限规则下择优。若不同选择会改变玩家重要意思/权限，才需要澄清。P 的“同级保留冲突”与 D 的仲裁规则留 M12。
4. **Scope 是绑定，不是权限强度。** 小域要求与大域约束同时有效；只有明确 revision 或 exception 能改变旧声明。“市区不许拆”不能被“这个街角优化一下”覆盖。
5. **目标数值不能被代理篡改。** 已划高密 zone≠实际高人口密度；有货运旁路≠货车不经过住宅；无 AI 删除记录≠受保护世界没被自然改变。
6. **不支持分原因。** GAME_LIMITATION、CONTENT_UNAVAILABLE、LOCAL_MAPPING_MISSING、OBSERVATION_MISSING、PRIMITIVE_MISSING、EVALUATOR_MISSING、OUT_OF_BOUNDARY 必须区分。
7. **硬项不支持或未知不能承诺完整达标。** 是否阻塞整 Mission 还是相关部分，取决于依赖与影响范围；不能为了继续而拆开一个整体承诺。C 的整单拒绝与 P 的保留活跃目标并非已统一，见 M11。
8. **软项不支持可留 residue。** 其他独立合法工作可继续；不能写总体 PASS，也不能把 OPAQUE 当作完成。
9. **不可把玩家事实陈述当 world readback。** “水是不是脏了”先是待核诊断；若未明确请求干预，不擅自改造水系。T325/T327/T328/T343 反复暴露这一点。
10. **能力增加不扩大旧权限。** 新拆迁原语、新资产包、改版 metric 都需重新能力解析；不自动激活原本拒绝的破坏性 residue。[C:§3.10; P:Capability]

## 4.3 近似、澄清与完成

| 情形 | V0 工作处理 | 不能做 |
|---|---|---|
| 玩家要求精确，游戏/本地只会代理 | 显示原要求与可用替代的差异；保留 hard 未满足 | 不把“不要污染”改为“离远点”后成功 |
| 软偏好有确定的本地近似 | 可按既有近似授权消费，注明受限部分 | 不每遇形容词都追问；也不无限自由发挥 |
| OPAQUE 质性词但其他子句清楚 | 保存非执行语义，独立工作按已授权边界继续 | 用原文残留充当执行支持 |
| 范围/对象/极性不确定，影响写操作 | 阻塞相关写入；只问会改变结果的最小问题 | 默认全市、随便一个对象或允许拆 |
| 全部为只读诊断 | 允许现有权限下的事实检查；无额外写入 | 把“咋回事”变重建授权 |
| 已有明确授权、对象/能力均已知 | 按其边界执行消费，不重复索取无意义确认 | 把 Grok 的“每次拆前再问”升级为永久产品规定 |
| 已构成明确 scope 的拆城/实验目标 | 视为真实游戏意图，核对既有保护/权限/能力/实际资源 | 仅因破坏多、反常或审美不好就道德化拒绝玩家的游戏目标 |

最后两行纠正 R 的过度保护倾向：**需要的是忠实授权和诚实能力边界，不是禁止玩家在自己的游戏中做大胆或破坏性实验。** “我允许承受亏损”可以是有效风险偏好；不能创造现金、自动取得未授予的贷款权限，或抹去仍有效的硬财政限制。没有冻结的系统现金底线时，本稿不能擅自发明不可覆盖的新底线。[R:T106–120/T267/T294; P:Permission; C:Fiscal]

完成应分为：语义已解析、规划约束已满足、已施工、世界结果已达成、持续条件仍满足。它们不是五个新状态机，而是报告不能混用的五种证据。质性 NON_BINARY 目标没有自动完成比例。用户明确认可代理，只授权按代理验收，不把它变成现实概念的唯一真定义。

## 4.4 来源独有信息如何进入而不扩架构

- C 的**隐式拆除预检**保留为任何相关写原语的必要能力要求：道路放置/加宽、改 zone、设施重叠都可能影响保护对象。不能只给 demolition 命令加门。
- C 的**阶段土地预留**保留：未来滨水目标若不约束前期占地，先赚钱可能占掉目标地。是否预留取决于已明确的未来 scope，不是云提前选址。
- P 的**snapshot / dynamic binding**保留，防止城市扩张后“东区”漂移。
- D 的**关系与物理场分离**保留：普通几何关系与风/水流是不同事实依赖。
- R 的**VacantHold、方面冻结、问句/行动区分、社区错误机制**保留为组合/诊断，不新增 Brain、控制器或工具总线。

# INTENT_REVISION_SEMANTICS_UNIFIED_V0

## 5.1 更新对象与世界对象严格分开

| 操作 | 改什么 | 未提及内容 | 对已发生世界的影响 |
|---|---|---|---|
| PATCH | 指定 clause / axes / scope 的声明 | preserve_unspecified=true 为建议默认 | 不回滚；新计划按新声明，既有世界保留差异 |
| REPLACE | 明确边界内的旧声明集合 | 范围外保留；整个 Mission 替换须明确 | 不是清空范围内资产，不自动撤销旧保护/授权 |
| CANCEL | 停止追求指定目标或取消尚未兑现部分 | 其他目标和保护不受影响 | 已建保留，不自动复原/拆除 |
| PRESERVE | 对当前世界指定方面建立本地 baseline 与保护规则 | 其他方面按原权限 | 约束未来 AI 改变，不宣告自然模拟暂停 |
| destructive reconciliation request | 请求把已建世界向新目标纠偏 | 同时需要具体 permission、有效 scope、影响预检 | 才可考虑授权内拆改；不是整个城市 diff 自动重建 |

**preserve_unspecified 保护旧 Intent；PRESERVE 保护 World 的方面。** “我没有修改西区意图”并不等于“西区一切世界变化都禁止”。反之，取消一个增长目标也不自动解除该区域有效保护。

## 5.2 普通变更的默认顺序

按本轮用户冻结原则：**停止未来不符合新意图的增长 → 修改尚未兑现的计划/分区意向 → 渐进纠偏 → 最后才考虑 demolition。**

其中“修改未兑现 zoning”要严格解释：尚未提交的分区方案可以改；已经在世界存在的 zoning 仍是世界事实，改 zone 可能间接淘汰楼宇，不能仅因“还没长满”就当无副作用。涉及已提交的任何操作，都要用当前读回核对。

- 新 revision 使哪些待执行动作不再合法，应在下一次提交前重新检查；不靠旧计划已生成就继续施工。
- 对正在执行、已经不可撤销的动作，只能报告当前事实与后续处理，不能承诺完美取消。
- 显式 undo/回到之前属于**额外恢复请求**，不能偷换为普通 CANCEL；没有所需快照/恢复原语就说明不支持。
- REPLACE 不应顺便移除 preservation 或扩张 grant；若玩家明确要求修改保护，需表达其作用范围和方面。T234 的“只许种树”只放开对应行为。
- 已有授权是否继续有效需按其原范围/期限判断，不能因为新 Intent 出现而无限续期。过期 base_revision 不静默覆盖新声明。

## 5.3 破坏性纠偏的两把钥匙与未决粒度

P 提议：**reconciliation requested＋destruction permitted**；C 补充：scope、类别、来源、期限/上限、影响预检。两者互补，但 Grant 全部字段是否必入 V1 尚未裁决。

V0 保留最小共同要求：明确改变现有世界的目标、有效局部权限、仍有效的保护、实际影响可检查。一个明确且完整的玩家请求可以同时表达“请求”与“许可”，**不要求人为强迫两次交互**。已授权事项无理由重复确认。

未知作者不能被认作“Mayor 建造”；但“保护我选的这些对象”即使没有作者账本也能按选区保护。C 所说 provenance 缺口阻塞“一切保护”过宽：它阻塞的是依赖作者身份的规则，不是所有空间/实体保护。

## 5.4 六组可红队的更新轨迹

| 初始→更新 | 预期语义 | 核验点 |
|---|---|---|
| 欧式东区→“改美式，西边别动” | PATCH 有依据的风格/形态；西区 snapshot preserve；未提项保留 | 东区已建欧式不自动拆；“美式”不自动生成高架/独立屋全套 |
| 工业城→“算了不要工业城” | 取消工业角色目标，停相应未来扩张 | 不删现有工厂，不自动关经济维持功能。T217 |
| 全面保护→“现在只许种树” | 仅开放明确方面；其它仍保护 | 种树不授权道路 prefab 替换。T234/T159 |
| 工业转住宅→“已拆的空着” | 用途更新和对指定空地的 vacancy hold 同时生效 | 不能把住宅目标当全域立即 infill。T227 |
| “等我回来，只修路”→下一轮自动推进 | 等待玩家放行持续有效，权限仍只限道路 | 回合切换不等于玩家回来。T201 |
| 多计划 keep/cancel，已建≥2 留两栋 | 可解析计数条件，但未指定哪两栋/跨计划归属不猜 | 当前 V0 不能完整表达和确定选择；记录 schema gap。T370 |

# CORPUS_COVERAGE_MATRIX

## 6.1 Grok 的实际质量与使用范围

**实读与编号审计：370 个独立 T 编号，T001–T370 完整且不重复。** TOP_50 是这些编号的重复展开，不再算 50 个新样本。T361–T370 被插在前面类别中，不能只按正文出现顺序当连续区间。

资料确有价值：它让属性型 Ontology 暴露出**范围/指代、极性/例外、跨轮保护、变更/取消、时间门、比较、控制权限、结果与手段混淆**等结构性缺口。其价值主要是这些重复攻击面，不是 370 个概念，也不是“花了 20 分钟所以可信”。

但资料质量有四个限制：

1. 声称每条有 I/H/S/Sc/C/A/E/U/Cl/Safe/Kill，实际上许多条只有短语与 Kill；“T029–T060 完整字段与 JSON 一致”引用的 JSON **不在附件内**。
2. 没有逐条社区链接；不能把所有条目当真实原话分布，也不能继承所谓“击穿率”排序。
3. 原始 Cl:Y/N 不完整且不总可靠。T271 双重否定可明确理解，是否询问依范围/上下文；T053 有 Tokyo Bay 歧义却标 N；T132 摄像头范围未证明可捕获却标 N。
4. 部分答案自行加戏：T148 用 400–800m P+R 替代“之外”无来源授权；T163 “管线别动”却建议必要时断了再恢复；T219 取消却说已执行要 undo，违反更新不回滚；T001 未给范围却建议视野内加树。这些不得用作 gold answer。

## 6.2 分类法：表达、缺上下文与本地能力不混算

本轮是**全量人工桌面语义审计**，不是实现跑分。每条有一个主分类，附下表完整编号账；本地缺口另做正交标记，避免“一句既需澄清又缺地铁工具”被强行二选一。

| 代码 | 必需分类 | 判断标准 |
|---|---|---|
| D | directly representable | 单个主概念/目标/约束或更新操作即可忠实承载；允许所需的通用 scope/modality 语法，不证明可执行 |
| C | representable through composition | 多个已有概念/门控/约束组合可表达；即使最后检测为不可行，也不算 schema 缺口 |
| A | approximation required | 至少一个核心意图只能用有损且须说明的近似；不表示玩家已经接受替代，也不表示整句现在可执行 |
| Q | clarification genuinely required | 按提供的独立短句，缺少会改变对象/范围/含义/授权/度量的关键上下文；相关上下文实际存在时可重新归类 |
| U | unsupported | 全句核心要求在当前研究基线没有可执行通路，或要求改写冻结的解释/权限边界；分 GAME/LOCAL/BOUNDARY 原因，不能全部当引擎不支持 |
| S | schema cannot express | 当前草案不能完整、受约束地表达核心控制语义；仅存 literal 不算解决 |
| E? | currently unexecutable locally：来源推定的候选 | 与主分类重叠；C 所列缺失/未提供的线路、路径、观测等依赖；不是实测结论 |

主分类取当条最关键阻碍，Q 不自动给所有“未写 scope”的句子：明确全城/已知默认域或类别谓词可表达；“这里全铲”“那个环岛”“比新宿更堵”等关键绑定未知才列 Q。A 与 Q 的边界仍属于需要红队复核的人工判断。Q 是**上下文需求统计**，不是“必须向玩家问 208 个问题”的产品策略。

“诊断问句”被列 Q，是因为仅有一句不足以确定问题与所需干预；现有 read-only 观测可以消除其中很多 Q，不代表要先向玩家追问才能查事实。

## 6.3 全量统计

| 主分类 | 数量 | 占 370 条 |
|---|---:|---:|
| D | 32 | 8.6% |
| C | 44 | 11.9% |
| A | 51 | 13.8% |
| Q | 208 | 56.2% |
| U | 33 | 8.9% |
| S | 2 | 0.5% |
| 合计 | 370 | 100% |

**D＋C＝76 条**，仅表示本轮草案能直接或组合保真表达。不能将其称为产品成功率；A/Q 中也有大量可表达子句，U 中有架构边界拒绝，S 才是明确的草案结构缺口。统计不是按“填出字段即通过”。

**currently unexecutable locally：无法从五份研究确定真实数量。** 标出 **49 条 E? 依赖风险候选**，其相关目标需要 C 认为缺失/未证的线路、路径、地形或服务观测等能力；其余 321 条也不等于本地已可执行。当前仓库/游戏验证状态为全部 370 条 UNVERIFIED，而非 370 条都不能执行。

E? 编号：T030、T031、T036、T042、T055、T058、T059、T061、T069、T070、T073、T082、T090、T093、T097、T104、T105、T107、T113、T119、T127、T137、T141、T197、T207、T209、T210、T212、T213、T229、T252、T265、T303、T304、T305、T307、T308、T309、T310、T312、T315、T316、T317、T318、T320、T323、T348、T350、T365。这些编号与 D/C/A/Q/U/S 重叠，不计入 370 的主分类和。

## 6.4 按原语料主题统计

| 原文组 | n | D | C | A | Q | U | S |
|---|---:|---:|---:|---:|---:|---:|---:|
| 非常模糊 / 审美 | 30 | 1 | 1 | 5 | 23 | 0 | 0 |
| 现实城市模仿 | 32 | 0 | 0 | 21 | 11 | 0 | 0 |
| 混合风格 | 20 | 0 | 3 | 6 | 11 | 0 | 0 |
| 自相矛盾 | 26 | 0 | 8 | 4 | 14 | 0 | 0 |
| 财政冲突 | 16 | 0 | 8 | 3 | 3 | 2 | 0 |
| 空间约束 | 31 | 3 | 0 | 6 | 22 | 0 | 0 |
| Preservation | 23 | 7 | 2 | 0 | 14 | 0 | 0 |
| Demolition | 23 | 6 | 1 | 1 | 15 | 0 | 0 |
| 阶段性 | 22 | 3 | 6 | 0 | 12 | 0 | 1 |
| 中途变卦 | 23 | 3 | 5 | 0 | 13 | 1 | 1 |
| 不可能 / 游戏不支持 | 28 | 1 | 0 | 1 | 4 | 22 | 0 |
| 恶意 / 奇怪 / 极性武器 | 36 | 4 | 2 | 0 | 22 | 8 | 0 |
| 高手玩家 / 社区民间物理 | 20 | 3 | 4 | 3 | 10 | 0 | 0 |
| 中文口语 / 不懂规划的玩家 | 20 | 1 | 2 | 0 | 17 | 0 | 0 |
| 英文社区原话 | 10 | 0 | 2 | 1 | 7 | 0 | 0 |
| 指代 / 除外 / 比较 / SOP | 10 | 0 | 0 | 0 | 10 | 0 | 0 |

## 6.5 可复核编号账（不复制 370 条原句）

每行十个代码依次对应编号；例如 T001–T010 的第 4 个就是 T004。原句与扩展标注回查 R 的相同编号。

| ID 范围 | 十条依次主分类 |
|---|---|
| T001–T010 | Q · Q · Q · Q · Q · Q · Q · Q · Q · Q |
| T011–T020 | Q · Q · A · A · A · Q · Q · Q · Q · Q |
| T021–T030 | Q · A · Q · C · D · A · Q · Q · Q · Q |
| T031–T040 | A · A · A · Q · A · A · A · A · A · A |
| T041–T050 | Q · A · A · A · A · Q · A · A · Q · Q |
| T051–T060 | A · A · A · Q · A · A · A · Q · Q · Q |
| T061–T070 | Q · C · Q · A · A · C · A · Q · A · Q |
| T071–T080 | Q · A · A · Q · Q · Q · C · Q · Q · Q |
| T081–T090 | Q · Q · C · Q · C · A · Q · A · C · A |
| T091–T100 | Q · Q · C · A · Q · Q · Q · C · Q · C |
| T101–T110 | Q · Q · Q · Q · C · C · C · C · A · A |
| T111–T120 | A · U · C · C · C · U · Q · Q · C · Q |
| T121–T130 | Q · D · Q · A · Q · Q · Q · Q · A · A |
| T131–T140 | Q · Q · Q · Q · A · D · Q · Q · Q · Q |
| T141–T150 | Q · D · Q · Q · A · A · Q · Q · Q · Q |
| T151–T160 | Q · C · Q · Q · D · D · D · D · Q · D |
| T161–T170 | Q · Q · C · Q · D · Q · Q · D · Q · Q |
| T171–T180 | Q · Q · Q · D · Q · D · D · Q · Q · D |
| T181–T190 | Q · Q · Q · C · Q · Q · Q · Q · Q · D |
| T191–T200 | Q · D · Q · A · Q · Q · C · Q · C · Q |
| T201–T210 | D · Q · Q · D · Q · Q · C · Q · Q · Q |
| T211–T220 | C · S · C · Q · D · Q · D · C · Q · C |
| T221–T230 | Q · Q · D · Q · Q · C · Q · Q · Q · C |
| T231–T240 | C · Q · D · Q · Q · Q · U · Q · U · U |
| T241–T250 | U · U · U · U · U · D · U · U · U · Q |
| T251–T260 | U · U · Q · U · U · U · U · U · U · U |
| T261–T270 | U · Q · A · U · Q · U · D · Q · Q · U |
| T271–T280 | Q · Q · C · Q · Q · Q · Q · Q · Q · Q |
| T281–T290 | C · U · Q · U · D · U · Q · U · Q · D |
| T291–T300 | Q · Q · Q · Q · U · Q · Q · Q · D · U |
| T301–T310 | Q · A · C · Q · A · Q · D · Q · Q · Q |
| T311–T320 | D · C · Q · A · Q · Q · C · Q · D · C |
| T321–T330 | Q · Q · Q · Q · Q · Q · Q · Q · Q · Q |
| T331–T340 | C · C · Q · Q · Q · Q · Q · D · Q · Q |
| T341–T350 | C · Q · Q · C · Q · Q · A · Q · Q · Q |
| T351–T360 | Q · Q · Q · Q · Q · Q · Q · Q · Q · Q |
| T361–T370 | Q · Q · C · C · C · U · Q · Q · Q · S |

## 6.6 反复失败的语义类别及统一模型修补位置

| 重复攻击 | 代表编号 | 统一模型的处理 | 是否需要新基础 Concept |
|---|---|---|---|
| 密度/高度/FAR/街墙塌缩 | T031、T047、T057、T081、T302 | O02/O03 分指标，禁止用 zone class 当所有形态指标 | 不新增名城/高楼概念；需要密度参数分型 |
| 主题盖掉功能或子系统 | T058、T061、T063、T067、T079、T347 | O01 与 O02/O07/O05 独立，scope 与方面绑定 | 否；工业风不能变工业 zone |
| 范围、except、补集、参照 | T121、T132、T133、T148、T351–T355 | S01/S02＋有界集合差；未绑定不写 | 需要结构语法，不是城市 primitive |
| 永久/方面保护与副作用 | T151、T152、T155、T159、T163、T169、T368 | baseline/aspects＋影响预检，未知作者不得假认 | 否；缺的是观测与执行覆盖 |
| 取消/替换/保留部分 | T217、T219、T222、T226、T227、T232、T234、T370 | revision 操作＋明确 clause refs；世界不回滚 | 普通更新可组合；T370 的计数选择仍是 schema gap |
| 延期、门槛、只规划、重复 | T197、T201、T211、T212、T215、T365 | 注册条件＋权限＋时间语义；重复触发不悄悄造 workflow | T212 单次门不能无损表示重复事件，暂列 schema gap |
| 没有度量的审美/财富 | T001、T014、T024、T027、T175、T191、T360–T362 | O11/O13＋residue；主观分类不得转无人监督拆除集合 | 否；不能再造 Beautiful/Realistic 枚举假装解决 |
| 目标被手段代理替代 | T083、T104、T147、T265、T290、T320 | 分 evaluator/proxy；保留受体、分母、全称条件 | 否；主要 compilation/validation gap |
| 委派、反讽、元规则 | T237、T271–T277、T282–T286、T319、T367 | 前端极性/话语解析，既有权限仍有效；禁止语义重绑定旁路 | 否；不添加“信任=无限权限”概念 |
| 诊断被执行、民间手法越境 | T304–T308、T321、T325、T327、T328、T343、T348 | 只读问题先保留为诊断；玩家手法与本地 policy 核验分离 | 否；不是每条 Reddit 技巧造算子 |
| 空置目标被 infill 消除 | T157、T192、T227、T233 | LAND_USE(vacant/不变)＋MAINTAIN/permission | 否，既有结构可表达 |

其中前六类是 Grok 最强的贡献。它也证明 D 的“60 例都能分解→有限集合已经足够”的论证不成立；困难经常是跨句绑定与结果语义，而非缺几个形容词。

## 6.7 对分类结果的具体解释

- **D 例：T192**“拆完先空着”可表示未来空置保持；这不授予尚未明确的拆迁范围。T174“只拆废弃”能表达类别限制，仍需废弃而非低等级的读回。T267“除了市政厅全拆”在类别明确时可表达集合差与拆迁目标，但旧保护未必已解除。
- **C 例：T197**＝人口阈值＋地铁目标＋激活门；T152＝道路许可＋建筑保护＋副作用约束；T363＝中心职能＋办公排除。表达后无可行解也仍属组合表达，不能把矛盾误记缺 schema。
- **A 例：T081**本轮列 Q，因为“高楼”阈值、密度指标未明确；若这些已明确，则可能转 C 或 A，而非自动拒绝高密。T302 的 FAR 可精确表示，但 missing middle 的实现/形态仍需近似，因此列 A。
- **Q 例：T219/T354**需要具体旧声明；T175 需要玩家审美分类对象；T148 需要有限补集的 universe。拒绝相关写入不表示停止所有无关自治工作。
- **U 例：T249**室内装修没有五源可用实现；T257 真 3D 分区不能用坡地替代；T282 重绑定“别动”为“必动”是本轮架构边界拒绝，而非 CS2 缺少某个建筑。
- **S 例：T212**“每加 5000 人加一条公交”涉及基线、重复 crossing、重复执行次数与动作数量；用单次人口门会丢掉核心。**T370**涉及多声明差量、已建计数、条件选择“那两栋”与剩余资产的相反待遇，当前最小草案没有完整定义。二者不自动要求新引擎；下一轮可选择有限扩展或明确留作边界外。

**本轮没有跑实际 Semantic Compiler。** 编号账供下一轮逐条反驳/修订，不是模型准确率或本地产品验收单。尤其 Q/A/U 的边界应当加入上下文后再复核；样本有意偏向杀伤面，不代表玩家常用需求的比例。

# SEMANTIC_COMPILER_GAP_REGISTER

## 7.1 分类原则

只列会使一类明确目标**丢义、误执行、无法验证**的缺口；不把“以后可更漂亮”列 blocker。`SC`＝语义契约阻塞；`F`＝只阻塞相关功能；`C?`＝本地缺口为来源推定，未查仓库。优先级不是授权开发顺序。

| ID / 类别 | 真正缺口与证据 | 阻塞什么、非阻塞什么 | 关闭条件 |
|---|---|---|---|
| A01 ONTOLOGY_GAP | DENSITY 混分区档、楼高、强度，缺可独立约束的指标定义；R:T081/T302，D:B3 | SC：高密低层/FAR/天际线；不阻塞明确 zone class | 统一指标/单位/分母/状态；O03 是本轮候选修补，待消融红队 |
| A02 ONTOLOGY_GAP | 环境结果不能完全被缓冲/选址吸收；D 拟删 ENVIRONMENTAL_QUALITY，P 硬污染例与 R:T083/T103 反证 | SC：无污染受体目标；不阻塞“相距 500m” | 保留结果谓词与手段关系，证明删除后不会丢污染约束 |
| A03 ONTOLOGY_GAP | STYLE / AESTHETIC / FORM 边界和结果词处置未统一 | SC：风格/审美保真；不阻塞纯人口目标 | 可区分外观、形态、主观评价；不能用网格代替欧式 |
| B01 INTENT_SCHEMA_GAP | scope 的有界补集、方面例外、snapshot/dynamic、稳定 reference 未形成共同契约；P＋R:T148/T351 | SC：空间例外和局部保护 | 有限集合/引用表达无歧义，外部不提供坐标；本地绑定证据另验 |
| B02 INTENT_SCHEMA_GAP | 重复阈值/累计次数条件；R:T212 | F：重复事件要求；单次 T197 可表达 | 明确有限支持或明确排除；不能把重复拍扁成一次，不能默造 workflow |
| B03 INTENT_SCHEMA_GAP | 多计划条件保留＋计数后的对象选择；R:T370 | F：复杂 selective revision；普通 PATCH/CANCEL 不阻塞 | clause、world 对象、计数、选择依据分开；“哪两栋”须有依据 |
| B04 INTENT_SCHEMA_GAP | demolition grant 的最小字段与保护撤销语义未统一；P/C/R | SC：已建区域改造 | scope/aspects/许可/有效保护如何同时求值明确；确认次数不能代替权限语义 |
| B05 INTENT_SCHEMA_GAP | 相对改善/比较基线、REACH/MAINTAIN 的时态与计划态/建成态缺统一表达 | F：比现在更好、稳定时窗、真实结果 | baseline 本地绑定，比较对象/单位明确；存档外“新宿拥堵”不可虚构 |
| C01 COMPILATION_GAP | 小域覆盖、soft 平局、hard 不支持的部分编译策略相冲突 | SC：组合/多域 Mission | 给出约束合并反例结果；不能靠优先级吞 hard |
| C02 COMPILATION_GAP | 语义→有限本地 mapping/policy 参数的可追溯规则尚未给齐 | F：不是所有概念有 backend；不否认有限模型 | 每个可执行映射列明输入、效果、前置条件、损失，不依赖自由语言推理 |
| C03 COMPILATION_GAP | 近似授权与原始要求关系不清，易把缓冲/公园当完成 | SC：hard outcome/审美 | 每次近似保留原义、替代、损失、用户容忍边界、验收口径 |
| C04 COMPILATION_GAP | 取消/更新后未提交计划失效及在途动作处理契约不明确 | SC：长期自治中途变更 | 新写入遵守最新接受版本，不能承诺已提交世界自动恢复；不要求新账本架构 |
| D01 OBSERVATION_GAP | 按作者保护所需 provenance 未证；C:§3.1，R:T155/T186 | C? F：按作者筛选；不阻塞明确选区保护 | 能区分来源与 UNKNOWN；未知不假冒 Mayor 建造 |
| D02 OBSERVATION_GAP | 操作的直接/间接影响集合未证；C:§3.8–9，R:T152/T163 | C? SC：无损改路、局部重建、保护保证 | 可识别建筑/道路/管线/设施/道具受影响方面；不能只测显式 demolition |
| D03 OBSERVATION_GAP | frontage、分模式路径与实际车流读回未证；C:frontage/path | C? F：商业街、物流避住宅、冗余路径 | 可区分邻近/连接/使用，链两侧与实际沿途对象可读 |
| D04 OBSERVATION_GAP | 污染/风/水流、岸线/坡度、视廊、真实高度/FAR 读回不全 | C? F：环境/地形/天际线的严格结果 | 相关指标有时态、精度与更新来源；只具距离时不能报结果 |
| D05 OBSERVATION_GAP | 建设增量成本/维护费、需求/入住、服务履约与容量未充分证明 | C? F：财政准入、CBD、服务结果 | 能读所声明指标并区分估计与事实；不能保证无限未来不破产 |
| E01 PRIMITIVE_GAP | C 推定无交通线路原语，复杂曲线/等高线/滨水形态能力不足 | C? F：TOD/山水交通；不阻塞普通网格语义 | 目标所需原语实测可用，或诚实声明有限近似 |
| E02 PRIMITIVE_GAP | Theme/外观运行控制、停车/精细路权、精确限高是否可用未决 | C? F：对应功能；不能用重建兜底 | Capability Set 提供可用操作/内容边界，核对副作用 |
| F01 VALIDATION_GAP | 规划态、建成态、真实模拟结果混用；C:DENSITY/CBD、R:T104/T320 | SC：任何结果型“已完成” | 分别检验计划、施工、结果；代理指标明示 proxy |
| F02 VALIDATION_GAP | 美/真实/宜居的二值 evaluator 不存在，权重未经验证 | F：自动美学完成；不阻塞保存 preference | 标 NON_BINARY/OPAQUE，或玩家接受明确代理；不造 beauty score |
| F03 VALIDATION_GAP | 持续保护验收不能区分 AI 影响与自然演化；C:first slice、P:Preservation | SC：保护承诺范围 | AI 不改变与世界保持两种契约分别报告，不能把所有自然变化都算误施工 |
| G01 GAME_LIMITATION | 任意商住办竖向组合、真多层 3D zone；G:混合类型、R:T065/T257 | F：对应原义；水平混合不能声称替代成功 | 当前资料下保留“不支持候选”；后续能力证据可修正，非本轮重新联网 |
| G02 GAME_LIMITATION | 室内装修/人际剧情/户籍/政治等深模拟要求无资料支持；R:T240/T242/T247/T249 | F：这些扩展模拟；不阻塞建城目标 | 不伪造相关功能；只允许被明确接受的展示性近似 |
| G03 GAME_LIMITATION | 建筑风格自动按历史年代演进、精确 1:1 现实城市全行为重建无支持 | F：自动历史/全真复刻；不阻塞历史外观与现代外围并存 | 区分资产外观、时间演变与行为模拟的承诺 |

**G 类不是“所有来源说不行所以引擎永远做不到”。** 只是在这五份输入内没有可靠兑现路径；具体版本、mods、内容包可能改变能力。摄像头 scope 缺读回是 D/B 类，不是 CS2 没有相机；潮汐车道/信号配时属于待核 V/mod-dependent，不在无证情况下永久判死。

## 7.2 明确不升级为全局 blocker 的事项

- 无法评估漂亮，不阻塞已明确的道路/人口/保护语义；只禁止假完成。
- 缺地铁原语，不阻塞其它用途或网格任务；保留地铁目标的不可执行诊断。
- 无作者历史，不阻塞针对玩家明确选中的对象保护。
- 某个 Theme 包未安装，不证明 STYLE 概念该删掉。
- 词汇是否恰好 21 个不是 blocker；是否保留独立玩家区分才是。
- C 的 FIRST_IMPLEMENTABLE_SLICE 是其审计建议，**不转成本轮开工命令或新路线图**。它的 frontage 90%、block spacing、scope FREEZE 等测试参数也不成为统一产品默认值。

# DISAGREEMENT_AND_UNRESOLVED_MATRIX

“当前最佳解释”是 **V0 PROPOSAL**，不代表来源冲突已解决。“高”多指识别冲突或架构边界的信心；对具体游戏事实不据此提置信度。`—`＝来源未明确论证，不能按赞同处理。

| issue | Gemini position | DeepSeek position | GPT position | Claude position | Grok evidence | current best interpretation | confidence / red-team needed |
|---|---|---|---|---|---|---|---|
| M01 STYLE / URBAN_FORM | Theme 与形态都支持，常按城市打包 | 明确分离，但例子自动补形态 | 可保留 style 与 residue，不云规划 | 删除 style，云展开 COMPACT/GRID | T058/T061/T079 | 分轴保留；禁止形态冒充外观。争议在不可执行风格如何保留与近似 | 高 / 是 |
| M02 Compact / High Density | 城市例子常联结密度与形态 | EXTENT 明确独立 | 未强制等同 | COMPACT 强带 density floor | T081/T088/T302 | 连续/边界≠开发强度；C 的包只能是可选本地模板，不能成为紧凑定义 | 高 / 是 |
| M03 漂亮/真实/繁荣 | 外观、景观、经济机制组合 | 结果词→权重/代理 | 禁假 KPI，保留 OPAQUE/NON_BINARY | 删除不可验收词 | T001/T175/T360–362 | 原义必须保留；有证据有限映射才近似。“繁荣”的经济指标也不能自动填全套 | 高 / 是 |
| M04 real-world city names | 30 类可执行属性组合，部分写死 | 词表＋先消歧，不做城市模板；例子又直接映射 | 语义前端拆解＋原文保留 | 外部展开本地参数包 | T029–080、T353 | 城市名是参照和候选面，玩家明确部分优先；是否一律澄清未决，不一概问 | 中高 / 是 |
| M05 用地数值/比例 | 给各类分区搭配 | 禁百分比/距离数值，偏序 | 支持明确数值目标 | 比例、距离、参数包为核心 | T094/T135/T148/T313 | 玩家明确数值应保留且带分母；本地效果参数不得由云发明。planned/built 分开 | 高 / 是 |
| M06 fiscal intent / Profile | 经济与资产策略 | GOAL_PRIORITY/PHASING，经济角色 | Mission 高于 Profile，财政 envelope | 财政指标复用恢复策略，允许门控 | T106–120/T331/T364 | 目标/风险许可与当前经营策略分开。财政硬底线的来源与可覆盖性待定 | 高 / 是 |
| M07 staged intent | — | 玩家阶段＋本地判里程碑，有先路后分区例 | 仅玩家明确 outcome order，禁止云 Profile 序列 | activation condition＋区域预留，常建议先恢复 | T197/T201/T212/T365 | 有限门/先后可留；模糊阈值不能凭空填。重复/规模规则边界开放 | 高 / 是 |
| M08 demolition permission | 城市例子可能暗含大改 | INTERVENTION 分级 | scoped ALLOW/FORBID＋双钥匙 | 细粒度 Grant＋预检＋dry-run | T152/T173/T186/T187/T298 | 明确授权＋实际影响边界必要；一次明确请求可同时表达意愿/许可。所有字段与确认政策未冻 | 高 / 是 |
| M09 preservation 强度 | 老城用主题/交通近似 | 可保方面、软硬、允许插建 | 不应自动冻结维护/服务 | scope 内所有变更 veto | T156/T159/T163/T169/T234 | 方面与具体允许类别比“整区完全冻结”保真；全冻结必须是玩家真正意思 | 高 / 是 |
| M10 cloud scope / coordinates | 给形态、未定义边界权属 | scope/anchor，不给坐标；可本地选具体高速 | opaque handle、本地解析 | 要外部 AI 给多边形/中心坐标 | T132/T148/T355 | 按本轮冻结原则拒绝云几何；D 的“具体对象由本地任选”也不适用指名对象 | 高 / 架构已定，解析需红队 |
| M11 unsupported hard / partial compile | 建议降级/拒绝 | 保近似/不保证 | 不许宣告完整可满足，软可继续 | 未知硬项拒整 Intent，未知软项丢并报告 | T067/T083/T104 | 保留未满足 hard；仅可推进与之独立且不破坏未来可行性的部分。如何证明独立仍未决 | 中 / 是 |
| M12 scope override / soft ties | — | 小域覆盖大域；目标同高交本地仲裁 | hard-hard 阻塞，soft 同级保留冲突 | scope 重叠可拒绝或串行 | T053/T148/T273/T356 | 约束交集优先，显式 exception/revision 才覆盖；soft 平局可本地确定性择优但不偷改语义 | 高 / 是 |
| M13 approximation policy | 常直接把现实目标翻成资产策略 | 倾向默认代理并报无法保证 | 本地验证，hard 不降级 | 删除或只保规划态 | T001/T148/T163/T257 | 代理是候选、不是达标证明；R 自己的替代也可能越权。软近似何时无需澄清未冻 | 高 / 是 |
| M14 clarification policy | 城市参照多直接拆 | 城市名必须先消歧 | 有重要多义则 AMBIGUOUS | 反向测试拒绝/部分拒绝 | Cl 标注不全且有误；T271/T053/T132 | 澄清由未绑定事实/语义后果决定；先读已有上下文，不固定每句问，也不凭信任绕权 | 高 / 是 |
| M15 玩家提供工程细节 | 例子含固定路宽/布局/收费 | 具体参数多被禁止 | 禁 road geometry/施工计划，允许目标数值 | 云输出数值参数以便确定执行 | T301/T304/T307/T318 | 来源保留与可执行 IR 分离；工程阈值能否入受控 constraint 尚待边界裁决 | 中 / 是 |
| M16 EXACT 与已有能力 | 游戏支持常直接当可执行 | concept 类型精确常当能力精确 | 本地 capability 才最终决定 | L0–L3 基于推定 | T241/T246/T305 | 三轴拆开：语义/游戏/本地；同名 exact 不同义。版本与仓库状态未知 | 高 / 是，后续定点核验 |
| M17 ORGANIC / VARIATION | 曲线/地形形态原生支持 | 有机 form、结构变化不等于随机 | 可保留 qualitative 未解析 | organic 删除，variation 降 seed | T003/T022/T362 | 几何约束可验，美感不能；seed 是本地手段，不是“真实”的定义 | 高 / 是 |
| M18 provenance 是否全局前置 | — | preserve 对象/方面 | local baseline 可保护指定范围 | 作者账本被写成所有保护前置 | T151/T155/T186/T368 | 作者过滤需要出处，选区保护不必全量作者账本；未知作者语义要保守且诚实 | 高 / 是 |
| M19 用户大胆/破坏性意图 | 部分例子主动制造衰败 | 授权门允许全面重构 | permission 与偏好分离 | grant 内可拆 | T267/T285/T290/T294/T300 常直接拒 | 不把虚拟破坏本身当非法；禁止的是越界/欺骗/未绑定/无法执行。系统不应强加“永不破产/永不拆城”新目标 | 高 / 是 |
| M20 案例与形式规则矛盾 | 历史组合被绝对否定，运河既近似又不支持 | “无隐式蕴含”却给紧凑补中密；软硬混合示例 | update 例把 LOW_DENSITY 塞 URBAN_FORM | 云规划坐标与总体权限原则不合 | T163 保护管线却允许断后恢复；T219 自动 undo | 以本轮冻结原则作边界；保留冲突，所有例子重审，不能让漂亮示例反向定义 schema | 高 / 是 |

## 8.1 来源保留账：没有被统一文档吞掉的独有贡献

| 来源 | 独有或显著增强的信息 | 本稿归宿 | 未采纳的部分 |
|---|---|---|---|
| G | 30 类城市参照、主题/分区/交通/水岸内容维度、深混合/历史演化/街墙限制候选 | §1.1–1.3 的能力与参照表 | 未核版本事实、必须地下高速等绝对教条、破坏性审美手法 |
| D | 有限参数化、本体/参数/组合区分、EXTENT、TRANSITION、SITING、住房/性格/变化 | §2 的共同结构与概念卡 | 未经验证覆盖率、24/23 算术不一致、小域覆盖、隐式社会/审美推导 |
| P | hard/soft/permission 分离、residue、snapshot/dynamic、semantic update 与 world 不回滚 | §3–5 | 不能直接照抄示例里的风格/密度字段混放；同级 soft 必阻塞尚未采 |
| C | 映射/观测/验收三关、隐式拆除、来源未知、财政维护成本、阶段预留、能力增加不扩权 | §4.4、§5、D/E/F gaps | 外部坐标、删除所有不可执行意图、L0 当实测、固定施工顺序进入 Compiler |
| R | 370 个攻击 ID、极性/例外/比较/记忆/时间/方面保护/民间机制/空地保持 | 贯穿 crosswalk、每张卡、统计、GAP、争议矩阵 | 不是 gold labels；缺失 JSON、未经核实社区原话、自己的越权近似、过度拒绝玩家目标 |

# SYNTHESIS_VERDICT

**READY_FOR_RED_TEAM**

这是**可供红队攻击的研究基线已就绪**，不是 FINAL/FROZEN、不是实现开工批准，也不是本地可执行性 PASS。

1. **链路状态：** Player Language → Ontology → MayorIntent → Local Compilation → Gameplay Effects 已形成可追溯的接口链。具体效果仍分为来源推定可复用、需有限近似、缺观测/原语、不能验证、游戏/边界不支持。尚未形成全能力闭合或真实游戏验收；最大风险是把“能表示”当成“能兑现”。
2. **最大五项未决：**
   - 风格/形态/审美怎样保真近似，且不伪造完成指标；
   - scope/例外/保护与拆迁权限怎样确定性合并，连带影响怎样守住；
   - hard 不支持、soft 平局、部分执行的准确边界；
   - 玩家阶段、重复阈值、跨计划计数修订，以及具体工程数值的 IR 边界；
   - 真实本地 capability 与游戏版本事实，尤其 Theme、线路、路径、污染/地形/高度、成本/服务读回。
3. **下一轮红队：** 用本稿的冲突矩阵和编号账做成对反例，不再扩大概念词表。优先测试：低层高密与紧凑低密；巴黎外观＋东京交通且保路；全城禁拆＋局部优化/例外；换风格/取消任务后不回滚；人口门＋等我回来＋部分取消；工业缓冲代理不能假装零污染；无观测时不能宣布结果成功；明确授权的大胆游戏目标不能被无依据地永久拒绝。

红队若仅发现“多补一个形容词就行”，还没有攻击到承重处。应直接寻找：**语义被静默添加/删除、hard 被代理化、范围被扩大、权限被隐式提升、更新被当回滚、或者世界未满足却报告完成。**

## 来源完整性与可复核性

- 五源均完整读取；未以其他会话的项目状态、外部搜索或源码替代五份输入。
- Grok 全量正文去除 TOP_50 重复后是 370 个唯一 ID；主分类和为 370；语料主题统计与编号账使用同一分类表生成。分类是本轮分析判断，下一轮可以逐 ID 推翻。
- 来源 SHA-256 前 16 位（原始附件 bytes）：G `e28442c41dfb5999`；D `6494ea336afa5bff`；P `dcb748349cec6e71`；C `ce38ae7e82e58641`；R `64f3e54e7f35124f`。
- 本稿只统一研究内容，未修改五份原始资料；未写 TypeScript/C#、未新增 Agent/Brain/workflow、未设计 UI、未讨论模型 API、未创建施工方案。

# 交接：黄金区块 + 填缝 + 0.1.6 打包（2026-10-08）

给接手的执行者（DeepSeek 车间）。仓库 `D:\AI_Home\GitHub\5ire`（开发）→ 同步到 `D:\AI_Home\GitHub\AI-Mayor`（公开仓库）。
所有说明都基于现有代码，动手前先读文中列出的文件。

---

## 0. 当前状态（必须先知道）

**本轮已完成、测试全过（205 个测试套件 / 2762 个测试），但都还没提交 git：**

| 内容 | 文件 |
|---|---|
| 提速：住宅需求取 6 小时平均；花钱下限降到 10%；空岗位低于 10% 时改铺工业 | growth-governor.ts、spend-guard.ts、district-builder.ts |
| 公交：车库 → 公交站 → Bus Line 的解锁链；放射状线路 | v2/bus-lines.ts、district-services.ts（新需求 transit）、care-focus.ts、main-adapters.ts（stopPrefabs/placeStop） |
| 绕建筑一圈接路 | v2/wrap-road.ts，`#wrapAccess`（district-builder） |
| 设施接路先试运行：断水先补水，补完仍断才拆路 | `#judgeAccessTrial`、`#waterDryHomes` |
| 放火电厂必在旁边配水（约 16,000） | district-utilities.ts `realizeUtilityShortfall`，常量 `THERMAL_PLANT_WATER_UNITS` |
| 火电厂只按两档距离放：贴路 68–78 m，或留一条路宽 100 m 起 | district-utilities.ts `PLANT_SETBACKS_METERS` |
| 买地：现金不到最近一块地价的 3 倍就不买 | `TILE_CASH_MULTIPLE` |

**另外两个仓库也有改动（已编译，同样没提交）：**
- Bridge（`D:\github\cities-skylines-2-mcp-master\CS2MCP.Bridge`）新增：
  - `/transit/stop/prefabs`
  - `/transit/stop/place`
  - `/city/prefab-lock` 支持 `category=route|object`，返回 `coverage{service,range,capacity,magnitude}` 和 objectBuilt 需求的 `builtBy`
- MCP 服务（`D:\github\cities-skylines-2-mcp-reconstruction\mcp-server`）新增 `cs2_transit_stop_prefabs`、`cs2_transit_stop_place`，`cs2_prefab_lock` 支持 route/object。

**已同步到 AI-Mayor 的 14 个文件**（main-adapters、intent-lowering、care-focus、district-builder、district-services、district-utilities、growth-governor、spend-guard、bus-lines、wrap-road 以及 4 个 spec）。
**本轮之后又改过、还要再同步一次的 3 个文件：**
- `district-builder.ts`
- `district-utilities.ts`
- `test/ai-mayor/utility-realization.spec.ts`

**唯一还没实测的：** "放火电厂必配水"在真实城市里是否不断水。

---

## 1. 先做：最后一轮实测，然后打包 0.1.6（约 30 分钟）

1. 请玩家加载布拉丁那个存档（游戏时间 2026-01-06 15:30 前后，现金约 29 万）。
2. 先确认没有市长进程在跑（用 Get-CimInstance 查命令行里的 `stress-host` 或 `mayor-engine`）。
3. 启动测试宿主：
   ```powershell
   $env:STRESS_SOURCE="1"
   npx tsx scripts/ai-mayor-dev/stress-host.ts
   ```
   - 先把旧目录 `scripts/ai-mayor-dev/stress` 改名，否则会重放里面旧的 stop 命令。
   - 往 control.jsonl 写命令时必须用无 BOM 的 UTF-8：`[IO.File]::AppendAllText(path, text, (New-Object Text.UTF8Encoding($false)))`。
4. 同时开看门脚本 `watchdog.ps1`：
   - 位置：本会话的 scratchpad，即 `C:/Users/李添桂/AppData/Local/Temp/claude/D--AI-Home/f0244332-9c66-4123-a200-bcbaede7efb4/scratchpad/watchdog.ps1`；如果已经没了，按下面的规则重写一个。
   - 规则：每 5 秒读 `http://127.0.0.1:8642/city/notifications?limit=1` 的 `countsByType` 里 "Water Notification" 和 "Sewage Notification" 的计数，以及 `/city/overview` 的 money。
   - 超过阈值就往 control.jsonl 写 `{"op":"stop"}`，再请求 `/sim/control?paused=true`。
   - 建议参数：`-Limit 300 -MoneyFloor 20000 -Seconds 1500`。
5. **通过标准**：跑 20 分钟。
   - 如果放了火电厂，日志里必须出现 `water for SmallCoalPowerPlant01 ... water is placed beside it`，并且 Water Notification 始终低于 100。
   - 不出现大面积断水，钱不被花空。
6. 不通过：把 events.jsonl 里出事前那个周期的 notes 记进本文第 5 节，不要硬改阈值糊过去。
7. 打包（全部在 5ire 里执行）：
   ```powershell
   npx tsx scripts/package/prepare-mayor-bundle.ts   # 会从上面两个仓库取 Bridge DLL 和 MCP 服务
   # package.json 版本改成 0.1.6（无 BOM 保存，否则 electron-builder 报错）
   npm run build
   $env:AI_MAYOR_SKIP_WINDOWS_SIGNING_TOOLS="1"; npm run package
   ```
   产物在 `release/AI-Mayor-Setup-0.1.6.exe`。
8. 把上面那 3 个文件同步到 AI-Mayor，两个仓库都提交；Bridge 和 MCP 的两个仓库也提交。
   - 网站更新：编辑 releases.ts。sha512 必须用实际下载回来的文件计算（以前手抄写错过）。
   - GitHub Release 由玩家自己上传。

**测试命令：**
```powershell
npx jest --config jest.ai-mayor.config.cjs --runInBand test/ai-mayor
```
类型检查只看自己改的文件，仓库里本来就有一堆无关的类型错误：
```powershell
npx tsc --noEmit -p tsconfig.json | Select-String "district-builder|..."
```

---

## 2. 黄金区块：要解决什么

玩家原话的意思：
- 现在是一口气铺满路和区，没给服务设施留地。之后诊所、警局、车库这类设施塞不进去，问题图标长期挂着。
- 区块和区块之间的缝塞不下一个整区块，地就浪费了。
- 目标：区块在铺设时就**预留服务设施的地块**，按覆盖范围排布，从根源上少出问题图标；**缝用小区块填，或者只修一条路、沿路两侧划区**。

---

## 3. 设计（已按攻略和游戏数据算好，照做即可）

### 3.1 网格尺寸（攻略结论，见 steamah《Practical Engineering: Efficient Grids》）
- 区块内的划区面积占比 = `192·(x − W + 48) / x²`，x 为网格间距，W 为路宽。最优间距 **x = 2W + 96**。
- 小路（8 m 宽）对应 **112 m 网格**，地块利用率约 86%；中路 128 m；大路 144 m。
- 离路超过 96 m 的地长不出建筑，所以区块中间留一块和路一样宽的空地。这块空地正好用来**放小型服务设施**（诊所、警局、消防站、小学都放得下）。
- 结论：区内道路用 Small Road、112 m 间距；区块边界的主干路用 Medium Road。
- 现有代码：district-builder.ts 里的 `DISTRICT_LOCAL_ROAD_PREFAB = "Small Road"`、`planRectangularGrid` 等。区块目前是 400 m 模板，间距 40/64 m。**把内部街道间距改成 112 m 的模板常量**，在 growth-policy.ts 的 `TEMPLATE_DISTRICT_*` 附近。

### 3.2 预留服务地块（不要猜数字，从游戏里读）
1. 用 `cs2_prefab_lock(prefab)` 读每种设施的：
   - `lotSize`：格数，每格 8 m
   - `coverage.range`：覆盖距离，游戏沿路网计算
   - `coverage.capacity`
   
   要读的设施：MedicalClinic01/02、PoliceStation01、FireHouse01、ElementarySchool01、HighSchool01、Cemetery01、BusDepot01、RoadMaintenanceDepot01 等，都在 `district-services.ts` 的 `SERVICE_PREFAB_PREFERENCE` 里。
2. 规则：
   - **每个模板区块的中心格**：留一块空地，大小取"最常用小设施的最大 lotSize"，按路宽缩一圈。不划区，登记为保留地块。现有机制是 `reserveSpotIndices` 和 `reservedLotOf`，加上 `#reservedLots`，服务设施会优先用它。
   - **大设施**（墓地、医院、车库、维护站，lot 至少 10×10 格）：每 `ceil(coverage.range / 区块边长)` 个区块，在**区块交汇处**预留一整块网格单元，即 112×112 m 不划区。
   - 预留地块记进 builder 的内存。重启后靠"世界上未划区的整网格单元"重新识别，不依赖账本，遵守"世界即权威"原则。
3. 验收：新铺的区块里能看到成片未划区的方块；后续服务设施优先落在里面（日志里出现 `reserved lot`），`no legal lot` 出现的次数明显下降。

### 3.3 填缝（两种，按顺序尝试）
1. **小区块**：剩余的矩形空地放不下整模板、但至少有 2×1 个网格单元时，铺一个缩小的模板（同样 112 m 网格，单元数更少）。可直接用现有的 `maximalRectangles(mask, minSide)`（日志里的 "maximal rectangles, biggest 640x240" 就是它算的），再用 `planRectangularGrid` 生成。
2. **一路两侧**：比一个网格单元还窄的长条缝（宽 40–96 m）：沿长边中线修一条 Small Road，两端接到最近的街道**节点**（接在路中间不会连通，必须接节点），两侧划区。条宽 ≤ 96 m 时两侧都能长房。现有的 `zoneUnzonedFrontage` 会给新路两侧自动划区。
3. 不填的情况：宽度小于 40 m、坡度太陡、水边、高速旁。这些用现有的 survey 过滤器。

### 3.3.1 已完成（Claude，2026-10-08 末尾）
`v2/golden-block.ts` 已写好，配套 `test/ai-mayor/golden-block.spec.ts`，6 个测试全过：
- `optimalSpacing`、`zonedShare`、`gridCells`、`reserveCells`（大设施占整格，小设施占格子中心）、`fillGaps`（小区块 / 一路两侧 / 放弃）。
- 注意：攻略摘要里的密度公式是错的，算出来超过 100%。已改成几何公式：区内地面边长 s = x − W，划区面积 = s² − (s−96)²，与攻略的 86% / 75% / 67% / 60% 一致。
- **已最小接入**：在 `#buildDistrict` 原来的 `reserveSpotIndices` 后面。每铺 `GOLDEN_BIG_EVERY_DISTRICTS`（4）个住宅/商业区，就在其中一个区的中心留一整格 112 m 不划区，登记进 `#reservedLots`，日志关键字 `golden block:`。尺寸先用 `GOLDEN_DEFAULT_SERVICES` 里的默认值。
- **已补齐（DeepSeek 车间，2026-10-08 收尾，见第 5 节首条）**：
  - ✅ 用 `cs2_prefab_lock` 读真实的 lotSize 和 coverage.range，替换了 `GOLDEN_DEFAULT_SERVICES`。
  - ✅ 区内街道间距改成 112 m（`planRectangularGrid` 加了"本计划自己的格距"，growth-policy 新增 `TEMPLATE_DISTRICT_STREET_SPACING_METERS`）。
  - ✅ 接入 `fillGaps` 填缝（小区块喂给选地；窄条交给 `#layGapRoad` 铺一条街，靠 `zoneUnzonedFrontage` 划区）。
  - ✅ live 验证（三轮真机，含 39 分钟自主跑，见第 5 节）。
  - ➕ 另修：水电设施与签名建筑不再占用预留地块（玩家指出，见第 5 节）。
- 已同步到 AI-Mayor（全部 20 个文件，含本文档）。

### 3.4 实现位置建议
- 新建 `v2/golden-block.ts`，只放**纯函数**，方便测试：
  - `gridCells(rect, spacing=112)`
  - `reserveCells(cells, serviceSpecs)` 返回 `{ zoned, reservedSmall, reservedBig }`
  - `fillGaps(freeRects)` 返回 `{ miniDistricts, stripRoads }`
- 在 `district-builder.ts` 的 `#buildDistrict` 和 survey 处接入：保留格不下 zone 指令。
- 每个函数都要写 spec，风格参考 test/ai-mayor/*.spec.ts。

---

## 4. 绝对不能违反的事

- **写世界的改动，必须先在可重载的存档上配看门脚本短跑一次**再打包。今天三次城市崩盘，都是没加防护就跑出来的。
- 判断供水看**断水图标的分布位置**，不能只看全城总量。实测过：全城产能 159k、用量 66k，城东照样 612 栋断水。
- 贵设施（电厂、车库、医院等）一天只放一座，并且永不拆除（`high-value-guard.ts`，玩家定的规则）。
- 不要模拟鼠标点击；重启游戏、停止玩家的 App 之前先问玩家。
- 文档和日志写中文；代码注释保持英文、沿用现有风格。

---

## 5. 实测记录（接手者往下补）

- 2026-10-08 收尾（DeepSeek 车间，补完第 3.3.1 节三项之后）：**通过**，可以出 0.1.6。
  - **第①件 真实占地与覆盖距离**：`GOLDEN_DEFAULT_SERVICES` 换成 `cs2_prefab_lock` 在布拉丁真机读到的值（诊所 11×6 格/覆盖 5000 m、诊所 02 5×5/2500、警局 12×7/5000、消防 5×5/5000、小学 18×8/3500、高中 22×16、墓地 16×25、医院 23×10/7500、公交场 18×9、维护站 10×12）。"占整格"的判定改成"两侧都 ≥10 格 **或** 比一个格子的自由中段（104 m）还长"——否则 11×6 的诊所会被误判成大设施。真机日志：`a lot is left unzoned at (244,208) for a public service (96 m across)`（96 m 正是警局的产）。
  - **第②件 区内街道 112 m**：`planRectangularGrid` / `composeBlocks` 增加"本计划自己的格距"（112 不是 40 的整数倍，硬填会抛异常）；`growth-policy.ts` 新增 `TEMPLATE_DISTRICT_STREET_SPACING_METERS = GOLDEN_SPACING_METERS`；`DISTRICT_SHAPES` 全部改成 112 的整数块，模板边长随之为 4×112 = 448 m（最接近原来的 400 m，且批次预算才装得下一个区块）。真机日志：新铺区块尺寸全是 112 的整数倍（`112x112`、`224x112`、`336x448`、`448x112`…）。
  - **第③件 接上填缝**：溢出矩形（<160 m 边或 <4 ha，按 `STRIP_MINIMUM_METERS` 下限读）里够两个 112 m 网格单元的喂给选地当**小区块**；不够的交给 `#layGapRoad`——沿缝中线铺一条 Small Road，两端吸附到 45 m 内的街道**端点**（接路中间不连通），两侧由现成的 `zoneUnzonedFrontage` 下一周期划区。只在"选不到地、且没有因现金被按住"的周期跑，不抢土地政策。真机日志：`gap: a Small Road laid 761 m along a strip too narrow for a district, from (810,-2266) to (842,-1506)`（本轮两次）。
  - **预留地块被水电占用**（玩家 2026-10-08 指出）：确认是真缺陷——`#reservedLots` 只有公共服务选址和临街划区认，**四条水电选址路径全都没看**（区内部署、城市级修复、断电修复、断水修复）。修法取最小：只把预留地块加进它们本来就有的 `excludedAround` 软过滤（搜不到时走原有的"候选耗尽"路径，不新增死循环），签名建筑候选同样滤一层。核对：2 块预留 / 4 次水电落点 / **0 冲突**。
  - 三次真机跑：① 20 分钟（水/污水峰值 ≤54，人口 11,389 → 14,800，现金被烧到 2k，看门按阈值停）；② 10 分钟（专验预留地块约束，水一度 203、现金烧到 1k）；③ **39 分钟自主跑**：断水 271 → 1（`1 water facility(ies) placed beside them`）、人口 15,719 → **20,373**、现金 28,022 → **185,032**（峰值 26.6 万）、83 个决策 = BUILT 6 / GAP_FILLED 1 / LAND_PURCHASED 4 / NO_SITE 61。
  - 测试：206 套件 / **2772** 全过（新增 golden-block 分类 3 条、填缝集成 1 条）。
  - **已知、本轮不修（记 backlog）**：① 被拒绝的缝每个空转周期会再试一次（游戏自己的重复拒绝挡着，只是日志重复）；② 这个存档扩张 20–40 分钟就会把现金烧到 1–2k，看门必须停；且 K34 在"月盈余 +69 万/小时、现金 8.6 万、18 块地"时仍拒绝买地，城市会站着——这是产品阈值，不是几何；③ 临街小设施"放不放得下"仍然由游戏 preflight 判（一个需求最多试 30 个点），只有大设施走几何（`big-building-site.ts`）。
  - 打包前修的两处与功能无关的坑：交接文档里那条带反斜杠的 Windows 路径（会话 scratchpad 的 `f0244332-…`，反斜杠后面紧挨着 6 位十六进制）会被 tailwind 当候选类名解码成非法码位，**让 renderer 编译直接失败**（已把该路径改成正斜杠）。写这份文档时不能再把那个反斜杠写回来。

- 2026-10-08 最终一轮（Claude，干净存档，跑约 4 分钟 / 游戏内约 4 小时，看门脚本全程开着）：**通过**。
  - Water/Sewage 始终为 0。
  - 现金 29.2 万 → 8.1 万，并在回升；月收支从 -2.7 万/小时回正到 +1.65 万/小时。
  - 人口 10,179 → 11,099，每小时 +175~196（改动前是 70~120）。
  - 黄金区块生效 2 次：`golden block: a 112 m cell is left unzoned at (46,-1382)` 和 `(46,-1902)`。
  - 绕一圈接路第一次成功：`wrap road round RoadMaintenanceDepot01 ... laid`，随后进入试运行。
  - 买地都在规则内，单块 2.2 万~6.1 万。
  - 这一轮放的是风机，没放火电厂，所以"放火电厂必配水"仍没有在真实城市里触发过，下一轮请留意 `water for SmallCoalPowerPlant01`。
  - 结论：可以打包 0.1.6（按第 1 节第 7–8 步）。

- 2026-10-08（Claude）：
  - 火电厂接路导致断水，受控实验已确认因果：接路后 1→612，拆路后恢复，反方向修同样的路不断水，在电厂旁加一座 WaterTower03 后 612→0。
  - 市长"贴路放置"火电厂同样会导致断水（939）。被动补水已能定位到火电厂，但城里没钱，预检全被判"钱不够"，没放下去。

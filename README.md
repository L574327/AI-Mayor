# AI Mayor（AI 市长）

> **本产品基于 5ire 社区版，与 5ire 无关。**
> *This product is based on 5ire Community Edition and is not affiliated with 5ire.*

《城市：天际线 II》（Cities: Skylines II）的自动市长。它接管你正在玩的城市，读地图上的问题图标，自己去修；你也可以用一句话告诉它想要什么。

**免费、开源。** 没有账号、没有试用期、没有任何功能与捐赠挂钩。目前是**早期版本（0.1.0）**。

- 下载：[GitHub Releases](https://github.com/L574327/AI-Mayor/releases) · [官网下载页](https://my-portfolio-six-livid-63.vercel.app/downloads)
- 作者的其他项目：<https://my-portfolio-six-livid-63.vercel.app/>

## 它现在能做什么

| 问题图标 | 市长的做法 |
|---|---|
| 没接上路、车进不去、人行不通、断头路 | 按建筑的入口铺接入路或临街路，接到现有路网的端头上 |
| 电线、水管没接上 | 从设施的接口铺管线接到最近的街 |
| 垃圾 | 在离住宅 250 米以外、靠街的空地上放填埋场、回收站、焚烧厂 |
| 废墟、废弃、烧毁的建筑 | 拆掉，原地块会自己长出新房子 |
| 交通堵塞 | 找到堵点的源头路口，撤多余红绿灯、加红绿灯、把双车道原地升一级，几小时后回读，变差就撤回 |
| 噪音 | 给噪音住宅旁的路种行道树，高速加隔音墙；新住宅离铁路、高速至少 100 米 |
| 污水、供水、供电不足 | 按需放设施，并读回确认已接上 |
| 缺钱 | 小步、可撤回地调预算和税率，不过度花钱 |

另外：自动扩张新区（住宅、商业、工业）、需要时买地、人口目标（到了就只维护不再外扩）。

**它不是万能的。** 复杂或特别具体的要求有时做不到：地铁、体育场、机场、指定税率、"西边那个旧工业区"这类具体位置都不支持。做不到的部分它会如实说出来，不会假装做了；实在没有能直接照做的部分时，它先照看城市里的各种问题。已有的空气污染、铁路边的噪音，目前没有办法消除。

## 用一句话下达指令

在主页的输入框里直接写：

- "垃圾太多了，路也不通，别拆我的房子，也别贷款"
- "先别扩张，把问题图标都处理掉"
- "人口做到十五万，老城区别动"
- "在城市西边建一片高密度住宅，可以买地"
- "给我建设一个漂亮的城市，要高楼大厦"

简单的话在本地直接听懂（离线、免费、不花 token）。复杂的话有两种办法：

- **填一个 API Key**（DeepSeek、OpenAI、Claude、Gemini、OpenRouter 或兼容接口）：每句话发一次翻译请求，每天有 token 上限（默认 20 万，设置里可改）。
- **半自动**：复制程序给的提示词，粘到任意 AI 聊天里，再把回复那一行粘回来。**复杂句请用逻辑强的 AI 并打开"深度思考"**，容易乱编的模型只适合简单句。粘回后程序会用文字写出它的理解，**你确认后才发送**。

外部 AI 只负责把话翻译成目标，不看你的城市，也不会直接操作游戏；随时掉线也不影响本地自治。

## 安装与使用

1. 运行 `AI-Mayor-Setup-<版本>.exe` 安装（它会把游戏模组装进 Mods 目录）。
2. 启动游戏、加载你的城市。**第一次装模组后要重启游戏**。
3. 打开 AI 市长，主页点"接管"，确认接管范围。
4. 随时点"停止"把城市交还给你。

需要：Windows 10/11，已安装《Cities: Skylines II》（已在 1.6.2f1 上实测，其他版本未验证）。

## 使用须知（请先读）

**它会真的改你的城市。** 铺路、划区、放建筑、拆废墟、买地、调红绿灯，都是真实写入。

1. **先备份，且不会替你读档**：每次接管前，程序先让游戏存一份 `AI Mayor backup <日期时间>`（存不成功就不接管）。想回到接管前，在游戏里载入它。程序不会自己读档、回档或启动游戏。
2. **花钱有保险丝**：任何会把金库打到"接管时资金 30%"以下的操作会被拒绝；一个游戏小时内的总支出也有上限（默认 15%）。贵的设施（电厂、回收站、焚烧厂、填埋场、医院等）**每个游戏日最多放一座，放了就不拆**，接不上路也不拆，留给你处理。设置在数据目录的 `spend-guard.json`，被拒的记录在 `spend-guard-refusals.log`。
3. **你点名的东西受保护**：指令里点名的区（"老城区别动"）和"不要买地 / 不要贷款 / 不要拆"等限制会被遵守。设置里的"保护我已有的建筑"默认关闭：关闭时，低密度的建筑可能被拆来腾地方。
4. **游戏速度**：市长运行时最高 4 倍速，需要时暂停。游戏本身占内存很大，运行市长时不要同时跑别的重任务。
5. **与其他模组可能冲突**：改道路、区域、红绿灯或模拟速度的模组，会互相干扰。
6. **数据位置**：`%APPDATA%\AI Mayor\`（设置、每个存档的记忆、日志）。卸载不会删它，想清除请手动删。API Key 用系统加密保存在本机。
7. **安装包没有代码签名**：Windows 可能提示"未知发布者"或被杀毒软件拦截，请确认来源后选择继续。
8. **免责**：本程序按"现状"提供，不保证每次都做对。重要的城市请先自己存档。

## 反馈与支持

- 问题和建议：[Issues](https://github.com/L574327/AI-Mayor/issues)。请附上：你说的话、它的字幕、游戏版本。
- 觉得有用，欢迎点一个 Star；也可以在[爱发电](https://afdian.com/a/9151a_)自愿支持，不影响任何功能。

## 开发

见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。测试：`npm run test:ai-mayor`。发布与更新流程：[`docs/RELEASE-AND-UPDATE-GUIDE.md`](docs/RELEASE-AND-UPDATE-GUIDE.md)，更新协议：[`docs/UPDATE-MANIFEST.md`](docs/UPDATE-MANIFEST.md)。

结构：桌面程序（Electron）里有一个市长引擎（独立子进程），通过 MCP 连接游戏里的 Bridge 模组（`127.0.0.1:8642`）。世界是唯一权威：先读游戏里的问题图标，再决定做什么，做完读回确认。

## 许可与致谢

- 许可见 [`LICENSE`](LICENSE)（沿用 5ire 社区版的许可，原文保留）；第三方声明见 [`NOTICE`](NOTICE)。
- 游戏侧模组与 MCP 服务基于 Apache-2.0 项目 cities-skylines-2-mcp（LancerComet）修改；`CreateDefinitions.cs` 移植自 LineTool-CS2（algernon）。

---

**English, in short.** AI Mayor is a free, open-source automatic mayor for *Cities: Skylines II* (early version 0.1.0, Windows). It reads the problem icons on the map (buildings with no road, unconnected power and pipes, garbage, ruins, traffic jams, noise) and fixes them, and understands plain-language instructions ("stop expanding, fix the garbage, don't demolish my buildings"). It backs up your save before every takeover, never loads or rolls back saves, has a spending fuse, and never demolishes or rebuilds costly facilities in a loop. An external AI (optional) only translates your sentence; for complex requests use a strong-reasoning model with deep thinking on. It cannot do everything (metro lines, airports, tax rates, named locations are unsupported) and says plainly what it left out. Based on 5ire Community Edition and not affiliated with 5ire; see `LICENSE` and `NOTICE`.

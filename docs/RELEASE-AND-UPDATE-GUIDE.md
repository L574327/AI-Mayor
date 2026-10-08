# AI 市长：打包、发布与更新操作指南

> 这份文档写给“以后的你”（或任何接手的人）。照着做就行，不需要再问别的 AI。
> 路径都以仓库根目录为准。

---

## 0. 一页纸总览

```
改代码 → 跑测试 → 改版本号 → 打包 → 算 SHA-256 → 传安装包到网站
      → 最后改 latest.json → 老用户下次启动自动看到“有新版本”
```

产品自己的更新协议只有一件事：**读你网站上的一个 JSON 文件**（`public/ai-mayor/latest.json`）。
协议细节见 `docs/UPDATE-MANIFEST.md`。

---

## 1. 日常开发

| 要做的事 | 命令 |
|---|---|
| 跑全部 AI 市长测试（必须用这个，它是串行的） | `npm run test:ai-mayor` |
| 类型检查 | `npx tsc --noEmit -p .`（仓库里有一批老的无关报错，只看你改的文件有没有新错） |
| 只跑一个测试文件 | `npx jest --config jest.ai-mayor.config.cjs test/ai-mayor/文件名.spec.ts` |

**重要：游戏开着的时候，不要同时跑全量测试/编译/打包。**
这些任务每个 node 进程占约 2 GB 内存，和游戏（约 15 GB）叠在一起，Windows 的“提交内存”会被顶满，
游戏会被系统直接关掉（实测两次，系统事件 2004 “虚拟内存不足”）。
必须做时：先在游戏里存档，或让产品停止（“停止市长”），再做。

---

## 2. 发布一个新版本（完整步骤）

### 2.1 改版本号
打开 `package.json`，改 `"version"`（例如 `0.1.0` → `0.2.0`）。
这个数字就是产品里“关于”页显示的版本，也是和 `latest.json` 比较的版本。

### 2.2 跑测试
```powershell
npm run test:ai-mayor
```
必须全绿再往下走。

### 2.3 打包
在 PowerShell 里，仓库根目录：
```powershell
$env:AI_MAYOR_SKIP_WINDOWS_SIGNING_TOOLS = "1"
npx tsx scripts/package/prepare-mayor-bundle.ts   # 打包游戏模组 + 市长引擎的连接器（只有改过它们时才需要）
npm run build
npm run package
```
成品：`release\AI-Mayor-Setup-<版本>.exe`（约 135 MB）。同目录的 `release\win-unpacked\` 是免安装版，用来快速试。

说明：
- `prepare-mayor-bundle.ts` 会把 `<CS2MCP.Bridge 源码目录>\bin\Release\CS2MCP.dll`（游戏模组）和
  `<mcp-server 源码目录>`（连接器）收进安装包。**改过这两个项目就必须先各自重新编译**：
  - 模组：`cd <CS2MCP.Bridge 源码目录>; dotnet build -c Release`（游戏要先关，否则 DLL 被占用部署失败；只想确认能编过可以加 `-p:ModDeployPath=...` 的任意 LocalLow 路径或忽略部署报错，产物在 `bin\Release`）
  - 连接器：`cd <mcp-server 源码目录>; npm run build`
- 安装包首次启动时，会把模组 DLL 复制到游戏 Mods 目录（哈希不同才覆盖）。**换了模组 DLL 的版本，玩家需要重启游戏才生效**，产品里会提示。

### 2.4 体检安装包（发布前 3 分钟）
```powershell
# 1) 安装包里不应出现“5ire”字样（About 页的声明除外）
# 2) 版本号对不对
(Get-Item .\release\AI-Mayor-Setup-0.2.0.exe).Length
# 3) 双击 release\win-unpacked\AI Mayor.exe，看 关于 页版本号、首页能打开、设置页能打开
```

### 2.5 算 SHA-256（更新校验用，必须）
```powershell
(Get-FileHash .\release\AI-Mayor-Setup-0.2.0.exe -Algorithm SHA256).Hash.ToLower()
```
把输出的 64 位小写字符串记下来。**产品只有在下载文件的哈希与 `latest.json` 里一致时才会运行安装程序。**

### 2.6 传到网站
你的网站项目在 网站项目（my-portfolio）（Vercel：`my-portfolio-six-livid-63.vercel.app`）。更新源和下载页**都由一个文件生成**：`src/content/releases.ts`。

1. 先把安装包传到一个能直接下载的 https 地址。Vercel 单个静态文件上限 100 MB，安装包约 130 MB，所以放 GitHub Releases（仓库 `L574327/AI-Mayor` 的 Releases）或对象存储，**不要**放进网站仓库。
2. **最后**再改 `src/content/releases.ts` 里的 `version`、`date`、`notes`、`downloadUrl`、`sha256`（2.5 算出的）、`sizeBytes`，提交并部署。顺序不能反：先传文件、后改这个文件。
3. 部署后，`/ai-mayor/latest.json`（产品读取的更新源）、`/downloads`（下载页）、产品页会同时更新。

### 2.7 `latest.json` 是怎么来的
不用手写：`src/app/ai-mayor/latest.json/route.ts` 读取 `releases.ts` 生成。字段含义见 `docs/UPDATE-MANIFEST.md`。`downloadUrl` 和 `sha256` 两个都有，产品才提供“下载并安装”；缺哈希就只会“打开下载页”。
### 2.8 验证更新链路
1. 浏览器打开 `https://my-portfolio-six-livid-63.vercel.app/ai-mayor/latest.json`，能看到 JSON。
2. 打开一个**旧版本**的 AI 市长 → 关于 → 点“检查更新”：应出现“有新版本 0.2.0”，首页也会出现提示条。
3. 点“下载并安装”：会下载 → 校验哈希 → 停止市长（游戏恢复成运行状态）→ 启动安装程序 → 软件退出。
4. 装完启动，关于页版本号变新。

---

## 3. 出问题怎么办

| 现象 | 原因与处理 |
|---|---|
| 关于页点检查更新，提示“没能检查更新” | 网站上没有 `latest.json`（404）、JSON 写错、或网络不通。浏览器直接打开该地址看。 |
| 一直提示有更新但装完还是旧版本 | `package.json` 的 version 忘了改，或 `latest.json` 的 version 写大了。 |
| 点“下载并安装”报“does not match its published hash” | `sha256` 与实际文件不一致（重新打包后忘了重新算，或网站上传了旧文件）。重算、重传。 |
| 发错了版本想撤回 | 把 `latest.json` 的 `version` 改回旧版本号或删掉文件即可，产品不会再提示。已经装上的用户需要你再发一个更高版本号的修复版。 |
| 想暂时关掉更新检查 | 删掉网站上的 `latest.json`（产品静默忽略）。 |
| 测试用自己的地址 | 启动前设环境变量 `AI_MAYOR_UPDATE_URL=https://.../latest.json`（必须 https 且以 .json 结尾）。 |

---

## 4. 代码在哪里（以后要改更新逻辑看这里）

| 功能 | 文件 |
|---|---|
| 更新协议的解析、比较、哈希校验（纯逻辑，有测试） | `src/main/services/ai-mayor/host/update-check.ts`、`test/ai-mayor/update-check.spec.ts` |
| 默认更新地址 | 同上，`DEFAULT_MANIFEST_URL` |
| 下载、校验、启动安装程序 | `src/main/main.ts`（搜 `ai-mayor-console-update-install`） |
| 界面（首页提示条、关于页按钮） | `src/renderer/apps/ai-mayor-console/ConsoleApp.tsx`（搜 `checkUpdate`） |
| 给网页端的协议说明 | `docs/UPDATE-MANIFEST.md` |
| 版本号 | `package.json` |
| 打包配置 | `scripts/package/index.ts`（electron-builder，`publish: null`，不会自己上传任何地方） |

---

## 5. 玩家数据在哪里（排查问题时用）

| 内容 | 位置 |
|---|---|
| 设置、记录器、备份清单 | `%APPDATA%\AI Mayor\`（子目录 `ai-mayor\`） |
| 日志 | `%APPDATA%\AI Mayor\logs\` |
| 市长的玩家限制（保护区、暂停扩张、人口目标） | `%APPDATA%\AI Mayor\ai-mayor\instructions.json` |
| 记录器的经验 | `%APPDATA%\AI Mayor\ai-mayor\experience-book.json` |
| 接管前的备份存档 | 游戏存档目录，名字以 `AI Mayor backup` 开头 |
| 游戏模组 | `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Mods\CS2MCP\` |
| 游戏日志 | `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Player.log` |

---

## 6. 发布前自查清单

- [ ] `npm run test:ai-mayor` 全绿
- [ ] `package.json` 版本号已改
- [ ] 改过游戏模组或连接器：已各自重新编译，再跑了 `prepare-mayor-bundle.ts`
- [ ] 打包成功，`win-unpacked` 能打开，关于页版本正确
- [ ] 算了 SHA-256，`latest.json` 已更新（**最后一步**）
- [ ] 用旧版本验证过“检查更新 → 下载并安装”
- [ ] 提交了代码（目前仓库里的改动还没有提交，提交需要你自己决定）

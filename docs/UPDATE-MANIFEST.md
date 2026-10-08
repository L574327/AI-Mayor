# AI 市长 更新协议（给网页端）

产品只读你网站上的**一个 JSON 文件**，不上传任何信息（连当前版本号都不发）。

## 放在哪里

默认地址（写在产品里）：

```
https://my-portfolio-six-livid-63.vercel.app/ai-mayor/latest.json
```

网站项目里不用手写这个文件：`src/app/ai-mayor/latest.json/route.ts` 读 `src/content/releases.ts` 生成，下载页、产品页、更新源三处同源。要换地址，改 `src/main/services/ai-mayor/host/update-check.ts` 里的 `DEFAULT_MANIFEST_URL`（也可以用环境变量 `AI_MAYOR_UPDATE_URL` 临时覆盖）。

## 文件内容

```json
{
  "version": "0.2.0",
  "notes": ["修了污水倒灌", "交通：整条走廊升级", "新增字幕"],
  "downloadUrl": "https://my-portfolio-six-livid-63.vercel.app/ai-mayor/AI-Mayor-Setup-0.2.0.exe",
  "sha256": "<安装包的 SHA-256，64 位小写十六进制>",
  "pageUrl": "https://my-portfolio-six-livid-63.vercel.app/ai-mayor",
  "minimumVersion": "0.1.0",
  "sizeBytes": 135257444
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 如 `0.2.0`。只比数字，高于当前版本才提示更新。 |
| `notes` | 否 | 更新说明，字符串或字符串数组，最多 2000 字。 |
| `downloadUrl` | 否 | **https** 的安装包地址。有它且有 `sha256`，玩家点一下就能在软件里下载并安装。 |
| `sha256` | 否* | 安装包的 SHA-256。**没有它，产品不会运行任何下载的文件**，只会打开 `pageUrl`。 |
| `pageUrl` | 否 | **https** 页面，在浏览器里打开（没有下载地址或没有哈希时用）。 |
| `minimumVersion` | 否 | 低于它的版本会被标为“需要更新”（仍然不强制）。 |
| `sizeBytes` | 否 | 用于下载进度。 |

\* 想要“软件内一键更新”就必须有 `sha256`。

## 算 SHA-256（Windows PowerShell）

```powershell
(Get-FileHash .\AI-Mayor-Setup-0.2.0.exe -Algorithm SHA256).Hash.ToLower()
```

## 产品这边的行为

- 启动后在后台查一次，之后每 6 小时一次；“关于”页可以手动点“检查更新”。
- 有新版本：首页出现一条提示，说明、版本号一并显示；玩家点“下载并安装”才会下载（到临时目录），校验哈希**通过**才启动安装程序并退出软件，不通过就删掉并报错。
- 请求失败（断网、文件不存在、JSON 不对）都静默忽略，不影响市长。
- 只接受 `https://` 的地址。
- 安装包是每用户安装（NSIS），覆盖安装不会丢设置和备份。

## 发新版的流程

1. 用 `npm run package` 打出 `AI-Mayor-Setup-<版本>.exe`。
2. 算 SHA-256，把安装包放到网站上。
3. 改网站项目 `src/content/releases.ts` 的 `version`、`date`、`notes`、`downloadUrl`、`sha256`、`sizeBytes`（`latest.json` 自动生成）。
4. 部署。老用户下次启动（或点检查更新）就会看到。

先传安装包、**最后**才改 `latest.json`，避免玩家点到还没传好的文件。

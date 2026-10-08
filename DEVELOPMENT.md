# AI Mayor 开发环境

## 需要

- Node.js 20+、npm
- 《城市：天际线 II》与 CS2MCP Bridge 模组（用于实机测试）
- .NET 8 SDK（仅在需要重新编译 Bridge 时）

## 常用命令

```powershell
npm install
npm run test:ai-mayor          # 市长引擎回归测试（jest）
npx tsx scripts/package/prepare-mayor-bundle.ts   # 把 MCP 服务和 Bridge 模组放进 mayor-bundle/
$env:AI_MAYOR_SKIP_WINDOWS_SIGNING_TOOLS = "1"    # 本机无法解压签名工具时
npm run build
npm run package                # 产出 release\AI-Mayor-Setup-<版本>.exe
```

## 实机测试宿主

`scripts/ai-mayor-dev/stress-host.ts` 用产品自己的监督者接管城市，从 `stress/control.jsonl` 读操作、向 `stress/events.jsonl` 写日志。
`STRESS_SOURCE=1` 用源码引擎（省掉重新打包）。中文指令必须写进 UTF-8 文件，不要通过命令行参数传。

## 约束

- 不模拟鼠标点击；游戏速度最多 4 倍；不读写玩家存档以外的文件。
- 世界是唯一权威：新原语 = 读世界 + 幂等。
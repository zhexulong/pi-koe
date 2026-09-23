# pi-koe

GameBuddy 的独立语音网关：本机环回、token 认证、只拥有音频捕获 / 转写 / 合成 / 播放。它不导入 Pi / Magic Context、不接触 Stardew bridge、不执行 Game Action、不持久化原始麦克风音频、不拥有 provider 凭据。

同时是 **pi 扩展**（`/voice` 命令族）与 **GameBuddy 的 voice 依赖源**（submodule + 版本化协议包）。

> **2026-09-23：从 `zhexulong/gamebuddy` 拆分。** 本仓库（原 monorepo 内的 `voice-gateway/` + `packages/voice-protocol/`）经 `git subtree split` 保留完整历史。GameBuddy 只消费版本化 `@gamebuddy/voice-protocol` 与发布产物，不依赖本仓库源码。

## 文档

| 文档 | 内容 |
| :--- | :--- |
| [docs/architecture.md](docs/architecture.md) | 分层、进程模型、epoch 与取消、失败策略、有界性 |
| [docs/protocol.md](docs/protocol.md) | v1 契约、v2 冻结契约、NDJSON framing、重放决议 |
| [docs/windows-audio.md](docs/windows-audio.md) | PowerShell 解析、常驻流式渲染、PTT 采集、卡顿判据、ASR 已知问题 |
| [docs/providers.md](docs/providers.md) | MiMo TTS、Groq Whisper、SenseVoice、音色与人格、凭据与授权 |
| [docs/gates.md](docs/gates.md) | 五级证据模型、无人测试方法、门禁脚本、未闭合项、CI |
| [docs/integration.md](docs/integration.md) | 双重契约、环境变量、发布策略、命名 |

## 快速开始

```bash
pnpm install
pnpm run build:protocol && pnpm run build

# 作为 pi 扩展
pi install <this-repo>
/voice status   # /voice start / /voice stop

# 直接启动（开发）
$env:GAMEBUDDY_VOICE_TOKEN = '<16+ opaque local token>'
$env:GAMEBUDDY_WINDOWS_OUTPUT_DEVICE = 'default'
pnpm start
```

启动日志区分 **`listening`（协议就绪）** 与 **`voice ready`（provider + 设备就绪）**。后者需要真实 key、设备，以及产品层的 cloud speech admission（见 [docs/providers.md](docs/providers.md) §6）——环境凭据不是玩家同意，缺少 admission 时保持纯文字。

## 开发

```bash
pnpm run typecheck      # tsc --noEmit
pnpm run test           # 构建 + 134 项测试
pnpm run test:extension # pi 扩展 smoke（fake pi API）
pnpm run build:release-artifact   # 生产 bundle（entry/protocol/ps1）
```

联合门禁需要 GameBuddy checkout：`GAMEBUDDY_HOST_ROOT=<path> node scripts/run-host-wire-bundle-rehearsal.mjs`。

项目不做原生编译：设备访问全部经 PowerShell（WinMM）子进程完成。

## 范围

- **当前**：受管 Push-To-Talk + 云端或本地 TTS 朗读；v1 协议为生产唯一有效协议，v2 已冻结且运行时落地。
- **不做**：in-game overlay、多角色音色分发、情绪标签提取管道、声卡混音 / AEC3。
- **未闭合**：L5 玩家发布门禁（需真人说话）；流式 ASR 上行。

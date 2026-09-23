# 集成契约

`pi-koe` 同时扮演两个角色，两者边界必须分开理解：

| 角色 | 消费方 | 契约 |
| :--- | :--- | :--- |
| **pi 扩展** | pi（开发者 / 本地操作） | `pi` manifest + `/voice` 命令族 |
| **Voice 依赖源** | GameBuddy（生产） | 版本化 `@gamebuddy/voice-protocol` + release artifact |

启动方式（pi 扩展、Desktop 直接启动、开发脚本）不改变业务所有权。生产真正需要的是**唯一且受管的生命周期 owner**——不能让 pi 扩展成为第二个 Desktop lifecycle root。

## 1. 作为 pi 扩展

```bash
pi install <this-repo>
pi   # 然后在会话里
/voice status | /voice start | /voice stop
```

- `package.json` 的 `pi.extensions` 指向 `extensions/index.ts`；工厂**不**在加载时启动任何资源（不启动进程、不开 socket、不设定时器），只在显式 `/voice start` 时启动，并在 `session_shutdown` 清理。
- 需要先 `pnpm build`；缺少 `dist/` 时 `start` 报告缺产物，而不是假装就绪。
- 默认端口 `49780`、默认 token 由进程 id 派生（仅本地开发用）。云 TTS 默认关闭——环境凭据不是玩家同意。

## 2. 作为 GameBuddy 依赖源

GameBuddy 只消费**版本化协议包**与**发布产物**，不依赖本仓库源码或内部 provider。

### 仓库挂载

```text
GameBuddy/.gitmodules
  vendor/pi-koe → git@github.com:zhexulong/pi-koe.git   （pinned commit）
```

### 协议包消费

`host/package.json`：

```json
"@gamebuddy/voice-protocol": "file:../vendor/pi-koe/packages/voice-protocol"
```

协议包先独立构建（`pnpm --dir vendor/pi-koe run build:protocol`），再跑 Host typecheck，避免干净 checkout 依赖陈旧的生成声明。

### 发布产物

`host/scripts/build-production-artifact.mjs` 在 release config 含 `voiceGateway` descriptor 时**自动**调用本仓库的 `build-release-artifact.mjs`，产出并把以下文件 stage 进不可变 generation：

| 产物 | 说明 |
| :--- | :--- |
| `.dist/entry/voice-gateway-entry.mjs` | 单文件入口 bundle（gateway + protocol 内联，仅 `node:*` 外部） |
| `.dist/protocol/voice-protocol-index.mjs` | 协议 bundle |
| `.dist/windows-waveout.ps1` | 播放 helper（必须与 entry 同级，`../windows-waveout.ps1` 相对解析） |
| `.dist/windows-wavein.ps1` | 录音 helper |

同时生成 admission sidecar `voice-gateway-admission.json`，把上述文件绑定到 generation 的 **完整 inventory digest**（不是 voice 子集 digest——子集语义会让生产准入永远失败）。

### Desktop 侧

Desktop 用 `InstalledVoiceGatewayAdmission` 校验 sidecar（schema、generation、inventory digest、path、SHA-256），再用 `VoiceLaunchCoordinator.Resolve` 组合：

```text
admit artifact + 读 Host-owned voice-preference
  → 仅 accepted 才生成 per-launch loopback port + opaque token
  → VoiceGatewaySupervisor 启动子进程（只注入 cloud TTS admission 当 cloudTtsAdmitted=true）
  → 同一 port/token 注入 Host 子进程
```

无 sidecar / 未决定 / 已撤销 / 坏文件 → 返回 null（纯文字）。**Voice 启动失败只降级语音，不影响 Host / Game。**

## 3. 环境变量

| 变量 | 归属 | 说明 |
| :--- | :--- | :--- |
| `GAMEBUDDY_VOICE_PORT` / `GAMEBUDDY_VOICE_TOKEN` | 启动方 | 环回监听与认证 |
| `GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION` | **产品层** | 只有 `desktop-consent-v1` 才允许云 TTS |
| `MIMO_API_KEY` / `GAMEBUDDY_MIMO_VOICE` / `GAMEBUDDY_MIMO_PERSONA` / `GAMEBUDDY_MIMO_STYLE` | 操作者 | provider 凭据与音色 |
| `GAMEBUDDY_WINDOWS_OUTPUT_DEVICE` | 操作者 | `default` 或 `waveout:N` |
| `GAMEBUDDY_WINDOWS_INPUT_DEVICE` | 操作者 | `default` 或 `wavein:N` |
| `GROQ_API_KEY` / `GAMEBUDDY_WHISPER_PROMPT` | 操作者 | 云端 ASR |
| `GAMEBUDDY_SENSEVOICE_ASSET_MANIFEST` | 操作者 | 本地 ASR 资产清单 |
| `GAMEBUDDY_HOST_ROOT` | 门禁脚本 | 指向 GameBuddy checkout（联合门禁用） |

## 4. CI

本仓库独立 CI 见 [gates.md](gates.md) §6。GameBuddy 侧：

- 主仓 `ci.yml` 的 `voice-gateway` job 带 `submodules: recursive`，在 `vendor/pi-koe` 内独立 install / build / test / typecheck。
- release lane 在 Host typecheck 前先构建 `vendor/pi-koe/packages/voice-protocol`。

两侧 CI 都不修改对方仓库；协议包的兼容性由双方各自的类型检查与协议测试守。

## 5. 发布策略

**当前不发布 npm。** GameBuddy 通过 submodule 的 `file:` 引用消费协议包。若未来需要独立版本化：
1. 给协议包补 `version` 与 changelog；
2. 用正式 npm 版本替换 `file:` 依赖；
3. 保留 release artifact 的 digest 绑定（admission sidecar），使 generation 与产物一一对应。

## 6. 命名

- 仓库：`zhexulong/pi-koe`（pi 生态命名，`koe` = 声）。
- 包：`pi-koe`（根）、`@gamebuddy/voice-protocol`（协议）。
- 历史上曾用名 `pi-voice-gateway` / `voice-gateway`；任务文档名 `voice-gateway-streaming-submodule` 保留，代表「具备独立生命周期与子仓属性的功能子模块」这一概念，不是当前路径。

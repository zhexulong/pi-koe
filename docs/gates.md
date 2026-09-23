# 门禁与证据

## 1. 五级证据模型

```text
L1 static → L2 deterministic → L3 integration → L4 real_environment → L5 player_release
```

| 等级 | 检验目标 | 证据形态 |
| :--- | :--- | :--- |
| **L1 static** | 类型与治理 | `tsc --noEmit` 零错误、Biome lint / format 干净、协议 exact-key 校验器 |
| **L2 deterministic** | 纯算法与数学 | 微块淡出连续性、分句与吞字、优先级队列、PTT 状态机、协议 round-trip / 拒绝 |
| **L3 integration** | 进程间与协议闭环 | 真实 socket + NDJSON、请求去重、epoch 拒绝、Host 纯文字降级 |
| **L4 real_environment** | 真实 Windows 硬件链路 | 真实声卡驱动、真实麦克风、真实 provider、真实设备 gap 统计 |
| **L5 player_release** | 玩家端到端发布 | 真人语音输入 + 完整交互 + 同意记录 |

### 发布约束

1. Voice 的任何测试或门禁结果**不产生** Chat / Game / Desktop 的 release pass。
2. 未执行、被阻断或证据不完整的检查项一律保持 `blocked` / `failed` / `uncertain`，禁止升级为 pass。
3. 当前状态：L1 / L2 全绿，L3 / L4 有真实证据（见下），**L5 未执行**。

## 2. 无人测试方法

真人说话不是模块级测试的前置条件。参考实现（livekit 的 `fake_io.py`、pipecat 的 `tests/utils.py`）都使用合成 / 预录 PCM + 虚拟时钟 + 内存 sink。

本仓库的无人基础设施：

| 文件 | 作用 |
| :--- | :--- |
| `synth-audio.ts` | 确定性 PCM 生成（DC / 正弦 / 静音 / 类语音） |
| `unattended-playback.ts` | `RecordingMixer`（收集所有 `play()` 为连续 PCM）+ 波形断言 |
| `streaming-pipeline.ts` | chunker → 逐句 TTS → 20ms 微块 → pump → mixer；`cancelSpeech` 淡出 + 丢弃未播队列 |

波形断言（不需要耳朵，也不会因环境噪声 flaky）：

| 断言 | 判据 |
| :--- | :--- |
| `maxSampleJump` | 相邻样本最大跳变——检出爆音（阶跃） |
| `trailingSilenceRatio` | 尾部静音比例——检出发声未干净收尾 |
| `hasRaisedCosineTail` | 尾部是否呈现升余弦包络 |

微块与淡出参数：`MICRO_CHUNK_MS = 20`、`FADE_MS = 5`、`SILENCE_MS = 10`，窗函数 `w(n) = 0.5(1 + cos(πn/N))`（`w(0)=1` 避免首样本不连续，`w(N-1)≈0` 平滑归零）。

> 参考实现（livekit / pipecat）的打断核心是「清空未播 buffer + 标记 interrupted」，**不承诺固定毫秒级淡出**。因此门禁断言的是「终态 = `cancelled`、未播队列被丢弃、surface 立即回 ready」，5 ms 淡出是实现细节而非通过条件。

## 3. 真实设备门禁（需要设备，不需要真人说话）

以下脚本都需要 `GAMEBUDDY_HOST_ROOT` 指向 GameBuddy 主 checkout（联合门禁要复用 Host 的 voice client 编译产物）。

| 脚本 | 用途 | 需要 |
| :--- | :--- | :--- |
| `run-pipeline-live-gate.mjs` | `--mode rehearsal`（合成音）/ `--mode live`（PTT + ASR） | 真实输出设备；`live` 另需麦克风 |
| `run-bundle-live-rehearsal.mjs` | **窄 child 环境**下启动 bundle 验证 `voice ready` | 真实设备 + MIMO key |
| `run-v2-wire-rehearsal.mjs` | 原生 socket 直接跑 v2 线缆（不经 Host client） | 真实设备 + MIMO key |
| `run-host-wire-bundle-rehearsal.mjs` | bundle + **生产 Host client**（`connectHealthyVoiceGateway`） | 真实设备 + MIMO key |
| `run-voice-surface-rehearsal.mjs` | v2 + surface 投影 `ready → speaking → ready` | 真实设备 + MIMO key |
| `run-streaming-3turn.mjs` | 三轮流式朗读，测边生成边出声的延迟与 `close` 收敛 | 真实设备 + MIMO key |
| `run-chat-voice-e2e.mjs` | **真实 LLM 流** → Chat sink → MiMo → 播放，全链 `completed` | 本机 LLM endpoint + 真实设备 |
| `run-chat-voice-gates.mjs` | 负向三场景：`revoked` / `crash` / `bargein` | 本机 LLM endpoint + 真实设备 |
| `run-deepseek-live-run.mjs` | 角色卡 + 世界书 + 真人可听回放 | 真实设备 + MIMO key |
| `run-player-release-gate.mjs` | **L5**：PTT 真人语音 → ASR → LLM → TTS → 播放 | **真人说话** |

### 断言示例

- 播放实时性：`wallMs ≤ audioMs × 1.08 + 500` 且 `gapsOverStepMs ≤ max(40, frames × 50%)`，超限报 `voice_gate_stutter` 并附 `playoutStats`。
- surface 生命周期：终态 `playback_observation(completed)` 后必须回到 `ready`。
- 负向：`revoked` 不启动 Voice child 且 Chat 文本流完好；`crash` 中途杀网关后 Chat 继续完成；`bargein` 终态必须是 `cancelled` 而非 `completed`。

## 4. 已实测的真实证据

| 验证 | 结果 |
| :--- | :--- |
| bundle + 窄 child 环境（显式删 `PATH`/`PATHEXT`/`USERPROFILE`/`APPDATA`/`windir`） | `voice ready`，v2 线缆 `completed` |
| host-wire rehearsal（bundle + 生产 Host client） | `completed`，`ready → speaking → ready` |
| chat-voice E2E（真实 LLM 5 deltas） | `completed`，`ready → speaking → ready` |
| revoked / bargein / crash 三场景 | 全部通过 |
| 卡顿自动断言（真实 MiMo） | 好的运行约 `maxGapMs 20–21 ms`、`gapsOverStepMs 0/466`、`wallMs ≈ audioMs` |

> 注意：证据文件（`scripts/pipeline-*.json`、`*.wav`）是机器本地产物，**不入库**。

### 一个容易误判的坑

多个 rehearsal 并发运行时，多个网关进程会抢同一个 WinMM 输出设备，表现为 `EPIPE` / `unknown_after_admission` / `playback_observation_missing`。这不是代码缺陷——串行运行即可确认。诊断时应先排除并发设备占用。

## 5. 未闭合项

| 项 | 状态 |
| :--- | :--- |
| **L5 player release gate** | 未执行（需要真人说话采样） |
| ASR 输入链路（设备枚举 / 低 SNR 幻觉） | OPEN，见 [windows-audio.md](windows-audio.md) §4 |
| 流式 ASR（边录边转写、partial 分发） | Phase 2，未实现 |
| `PttKeyStateMachine` → `waveIn` 预录音接线 | 状态机已落地，物理采集未接线 |
| `FrameProcessorQueue` → 运行时调度接线 | 队列已落地，协程接线未完成 |
| 免提 OpenMic / 持续 VAD / AEC3 / 系统音频环回 | 明确排除在当前范围，作为独立提案 |

## 6. CI

`.github/workflows/ci.yml` 三个并行 job（全部必须绿）：

| job | runner | 内容 |
| :--- | :--- | :--- |
| `check-gateway` | windows-latest | `install → build:protocol → typecheck → build → test`（134 项） |
| `check-extension` | ubuntu-latest | fake pi API 加载扩展，断言 `/voice` 注册与 shutdown 清理 |
| `check-release` | windows-latest | `build:release-artifact` + 断言四文件闭包（entry / protocol / waveout / wavein）存在且非空 |

gateway 测试放在 Windows 上是因为语音测试会走 WinMM / PowerShell spawn 路径（通过 fake 覆盖，不需要真实设备）；扩展检查放在 Ubuntu 上以证明 pi 生态在标准 runner 上可加载。

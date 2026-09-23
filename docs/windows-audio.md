# Windows 音频链路

网关不做任何原生编译：全部设备访问通过 PowerShell（WinMM）子进程完成。这带来两个必须显式处理的工程约束——**子进程解析**与**设备节奏**。

## 1. PowerShell 解析（常被忽略的生产缺陷）

`resolvePowerShellExecutable()` 从 `SystemRoot` 派生绝对路径 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。

原因：生产 Desktop supervisor 给子进程的是**最小环境**（只有 `SystemRoot` / `TEMP` / `TMP` / `LOCALAPPDATA` 等），没有 `PATH`。而 `powershell.exe` 位于 `System32\WindowsPowerShell\v1.0\`——不在 CreateProcess 的默认搜索目录内，裸名 spawn 必然失败，表现为「网关明明活着但永远 `voice unavailable`」。

三个 spawn 点（streaming mixer / batch waveout / wavein capture）统一使用该 helper；**不**通过扩大子进程环境注入 operator `PATH` 来绕过。

## 2. 输出：常驻流式渲染

`windows-waveout.ps1 -Mode stream` 是唯一的现代输出路径：设备打开一次，stdin 以 `[4-byte LE length][PCM16 bytes]` 帧持续输入，零长度帧表示 EOF。

| 参数 | 值 | 说明 |
| :--- | :--- | :--- |
| 设备 | `default` 或 `waveout:N` | `default` 每次打开时由 Windows 解析当前默认多媒体输出；显式端点**不**静默回退 |
| 采样率 | 16000 Hz / mono / `pcm_s16le` | 与线缆契约一致（provider 侧重采样到 16 kHz，见 [providers.md](providers.md)） |
| 完成通知 | `CALLBACK_EVENT` | 驱动完成 buffer 时唤醒；替代 `Sleep(2)` 轮询（实测该轮询粒度 ~15.6 ms，比 20 ms 帧还大，是卡顿第一来源） |
| 事件句柄 | static 字段 | 局部 `AutoResetEvent` 在 >2s 播放中会被 GC 回收 SafeWaitHandle，导致 `Handle is not initialized` |
| 抖动队列 | 后台线程排空 stdin | 渲染循环与 stdin 读取解耦 |
| 预灌 | 约 320 ms（16 帧） | 播放开始前建立深队列 |
| 补充策略 | **补满所有空闲槽** | 1:1 补充无法建立深队列，每帧都要重付 `unprepare → write → prepare` 开销（实测每帧 ~30 ms、`wallMs` 达 `audioMs` 的 1.5×） |
| 收尾输出 | 单行 JSON | `{frames, audioMs, wallMs, maxGapMs, gapsOverStepMs}` |

`streaming-windows-audio.ts` 侧：

- `createStreamingWindowsAudioMixer(device)` 启动子进程，先写入 10 ms 静音帧作为启动探针，等待接受或子进程退出（`STARTUP_TIMEOUT_MS = 12_000`）。启动 timer 在成功后必须清除，否则长时间播放会被误判失败。
- `play()` 单帧上限 `MAX_FRAME_BYTES = 1_920_000`、偶数长度。
- **`stop()` 是立即打断**（取消路径）；**`close()` 是 EOF 自然排空**——让设备播完全部已入队 PCM 后再输出完整统计。两者语义不同，混用会导致统计只覆盖前几帧。

### 卡顿的客观判据

不依赖人耳：live gate 断言

```text
wallMs ≤ audioMs × 1.08 + 500
gapsOverStepMs ≤ max(40, frames × 50%)
```

超限即 `voice_gate_stutter` 失败并记录 `playoutStats`。阈值来自真实设备实测（好的运行约 `maxGapMs 20–21 ms`、`gapsOverStepMs 0`、`wallMs ≈ audioMs`）。

## 3. 输入：PTT 采集

`windows-wavein.ps1` + `WindowsPttCapture`：

- 设备选择仍是 `default` 或 `wavein:N`。**参考实现（pipecat 的 `input_device_index=None`、livekit 的 WebRTC 默认音源）都使用系统默认输入端点，不手工枚举微端**；本仓库遵循同一策略——枚举端点常指向虚拟设备（Stereo Mix 回环、厂商降噪端点），而不是玩家物理麦克风。
- 采集只在显式 PTT 生命周期内发生（`capture` / `stop`，由命名事件协调）；`MaxDurationMs` 默认 30,000、允许 100–60,000。
- 单次采集上限 `MAX_CAPTURE_BYTES = 960_000`；PCM 必须非空、偶数长度。
- 原始音频不持久化：临时 WAV 在成功、失败或取消后都删除。

## 4. 已知问题：ASR 输入链路（未解决）

**状态：OPEN，不作为当前 release 阻塞项。**

- **现象**：真机 L5 gate 曾转录出与玩家话语无关的内容（如「字幕志愿者 李宗盛」类文本）。
- **证据**：录音 `player-turn-0.wav`（15 s @16 kHz mono）逐秒 RMS 显示 0–3 s 底噪约 1300、4–6 s 出现强语音段（rms 7851/3958/9893）、7–15 s 安静（rms 200–570）。强语音段是真实声音而非数字噪声，来源不明（环境拾音 / 回环 / 扬声器串扰均可疑）。
- **设备风险**：部分机器的枚举端点（`wavein:0` 等）是 Stereo Mix / 回环设备，会采集系统正在播放的声音——包括网关自己刚播出的 TTS 与 Windows 提示音。
- **低 SNR 幻觉**：能量接近静音的片段，Whisper 会编造平台风格文案；不能把低能量段的转录当作玩家输入。
- **当前处置**：不修复。录入门禁必须以 RMS / 能量分段作为前置判定，而不是以 ASR 文本为唯一依据；流式 ASR（边录边转写）与 VAD 端点检测仍是 Phase 2 事项。

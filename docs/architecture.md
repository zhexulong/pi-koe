# 架构

## 1. 定位

`pi-koe` 是一个**本机 sidecar**：绑定 `127.0.0.1`、要求 16–256 字符不透明 token、用 NDJSON 与调用方通信。它拥有音频捕获、ASR 调用、TTS 合成与声卡播放；它**不**拥有对话历史、不做 Game Action 决策、不持久化原始音频、不保存 provider 凭据。

```text
调用方 (GameBuddy Host / pi 扩展 / 其它)
   │  NDJSON over 127.0.0.1
   ▼
server.ts ── VoiceGatewayCore (gateway.ts)  ← 唯一状态与 epoch owner
   │            ├── capture  (capture coordinator + PTT 状态机)
   │            ├── ASR      (AsrProvider)
   │            ├── TTS      (TtsProvider)          ← v1: 队列式 / v2: 流式
   │            └── mixer    (Mixer)                ← 唯一播放 owner
   ▼
Windows: PowerShell 子进程 (waveOut 常驻渲染 / waveIn 采集)
```

## 2. 进程与所有权

| 角色 | 拥有 | 不拥有 |
| :--- | :--- | :--- |
| `server.ts` | listener、socket 认证、请求去重、按 socket 生命周期 | 音频设备、provider |
| `VoiceGatewayCore` | `connectionEpoch`、speech 队列、capture 生命周期、provider readiness | 设备句柄 |
| `V2StreamingRuntime`（每 socket 一个） | v2 streaming job 表、单一 pipeline、pump 循环 | v1 队列 |
| mixer | 唯一物理播放通道（一个子进程） | 文本 / 协议 |

**单 mixer 不变量**：任何时刻只有一个 mixer 持有输出设备。v1 队列与 v2 streaming 共用同一个 mixer；调用方不需要（也无法）选择输出通道。

## 3. 终止与 epoch

`connectionEpoch` 是取消的线性化依据：

- `VoiceGatewayCore.stopAll()` 递增 `#epoch`，随后取消 capture、标记全部 active speech 为 `cancelled`、清空队列、`mixer.stop()`。
- 任何携带旧 epoch 的 capture / speech 回调在播放前被丢弃（`job.epoch !== this.#epoch` 检查）。
- v2 每 socket 的 `V2StreamingRuntime` 在构造时固定 `connectionEpoch = core.epoch`；epoch 变化后旧 socket 的 v2 请求被拒绝为 `stale_connection_epoch`。
- 旧 epoch 的音频**永不重新播放**——这是「取消后无音频泄漏」的实现依据。

三层停止语义互不伪装：

| 操作 | 效果 |
| :--- | :--- |
| `capture_cancel` / `cancel_capture` | 只停麦克风采集与本次 ASR |
| `speech_cancel` / `cancel_speech` | 只停该 TTS job（网络 / 解码 / 队列 / 播放） |
| `stop_all` / `STOP_ALL` | 幂等收束本网关的采集、合成、播放与全部等待队列 |

停止不等待云端响应、完整解码或自然句尾。

## 4. 失败策略：永不伪装，且永不击穿宿主

| 失败 | 行为 |
| :--- | :--- |
| 没有 API key / 没有语音 profile / 没有设备 | 保持 `speech unavailable`，纯文字继续可用 |
| 设备打开 / 写入 / 完成失败 | 撤销该进程的 readiness；`Mixer.play` 拒绝 |
| 播放中途失败（v2） | job 结算为 `failed_before_side_effect`（零播放）或 `unknown_after_admission`（已有副作用）；**网关继续存活** |
| TTS 合成失败（v2） | 丢弃该 job 剩余队列，同样按上面两类诚实结算 |
| 清理失败 | 进入 `quarantined`，拒绝新的变更请求，`reasonCode=quarantined_cleanup_failed` |

网关进程的崩溃、GC 停顿、重连或冷启动**不得**阻塞调用方主进程。

## 5. 并发与有界性

| 资源 | 上限 | 位置 |
| :--- | :--- | :--- |
| capture 累计字节 | 960,000 B | `gateway.ts` |
| speech 队列长度 | 3 | `gateway.ts` |
| speech 累计音频 | 1,920,000 B | `gateway.ts` |
| 事件历史 | 2,048 条 | `gateway.ts` |
| NDJSON 单帧 | 64 KiB | 协议包 |
| request 重放缓存 | 容量 1000 / TTL 60s | `server.ts` |
| v2 单 job 文本 | `MAX_JOB_TEXT_LENGTH` | `v2-streaming.ts` |
| v2 单 chunk 文本 | `DELTA_TEXT_LENGTH` | `v2-streaming.ts` |

## 6. v1 与 v2 的关系

- **v1（生产唯一有效协议）**：请求 / 响应式。`ptt_start` → `ptt_frame` → `ptt_stop` 得到 `final_transcript`；`speech_enqueue` 排队整段台词；`events` 轮询事件流。
- **v2（已冻结，运行时已落地）**：认证后的同一 socket 上推式。发送 `stream_speech_chunk` 增量文本，服务端主动推 `playback_observation` / `gateway_state`；无轮询。

两者**共用**同一个 v1 `hello` 认证：v2 没有自己的握手，也不需要。详见 [protocol.md](protocol.md)。

## 7. PTT 按键状态机

`PttKeyStateMachine`（纯同步、时钟注入、不读 `Date.now()`）：

| 参数 | 值 | 语义 |
| :--- | :--- | :--- |
| `TYPING_COOLDOWN_MS` | 400 | 打字冷却窗口内的按键被完全忽略（`cooldownIgnored`） |
| `PROMOTE_MS` | 700 | 长按达到阈值时，预热录音无缝晋级为正式录音（消除句首吞字）；短按丢弃 |
| `TAIL_MS` | 1200 | 松键后的尾随吸附窗口，窗口内再按合并为同一输入段；窗口期满恰好 `finalize` 一次 |

状态流：`idle → warmup → capturing → tail`。该状态机**不接触** `waveIn` 设备，实际采集接线仍待完成（见 [gates.md](gates.md) 的未闭项）。

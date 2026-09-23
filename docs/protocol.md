# 协议

唯一协议 authority 是 `packages/voice-protocol`（`@gamebuddy/voice-protocol`）。调用方与网关都必须消费它导出的常量、判别联合、exact-key 校验器、编码器与帧上限；两端不得各自写死常量。

## 1. 传输

- 传输为 TCP over `127.0.0.1`，NDJSON（每行一条 JSON 记录，`\n` 结尾）。
- 单帧上限 `MAX_NDJSON_FRAME_BYTES = 64 KiB`（编解码双向一致）。
- framer 是 fatal-UTF-8、byte-bounded：拒绝 malformed UTF-8、超长记录、CRLF、空记录与 trailing incomplete frame；支持被拆分的多字节字符与合并的多条记录。
- 连接必须先用 `hello` 认证成功，之后才接受其它请求。

## 2. v1 契约（生产唯一有效协议）

`VOICE_PROTOCOL_VERSION = 1`。

### 请求

| type | 关键字段 | 说明 |
| :--- | :--- | :--- |
| `hello` | `token`, `protocolVersion` | 认证；失败即断连 |
| `health` | `voiceProfile?` | 返回 readiness 与 capabilities |
| `ptt_start` | `sessionId`, `inputId?`, `locale?` | 开始一次 PTT 采集 |
| `ptt_frame` | `pcm16Base64`, `format?` | 推入 PCM 帧；格式不符即拒绝 |
| `ptt_stop` | `reasonCode?` | 结束采集并触发 ASR |
| `capture_cancel` | `reasonCode?` | 只取消采集与本次 ASR |
| `speech_enqueue` | `job` | 排队整段台词 |
| `speech_cancel` | `jobId`, `reasonCode?` | 只取消该 TTS job |
| `stop_all` | `reasonCode?` | 幂等收束全部语音工作 |
| `events` | `after?`, `sessionId` | 轮询事件流，返回 `next` 游标 |

### 响应

`hello_ack` / `health` / `accepted` / `events` / `error`。`error` 携带 `reasonCode`，`requestId` 在无法归属时为 `null`。

### 事件

`capture_state`、`partial_transcript`、`final_transcript`、`asr_failure`、`speech_state`。

最后一条 `final_transcript` 是唯一可交付给调用方 Agent 转录的事件；`partial_transcript` 仅供 UI，不得作为持久事实或触发推理。

### 音频格式

`REQUIRED_PCM_FORMAT`：**16000 Hz、1 channel、signed 16-bit little-endian（`pcm_s16le`）**。`ptt_frame` 的 `format` 若与本契约不符，网关拒绝该帧而不是猜测。

### 上限

`MAX_VOICE_TEXT_LENGTH = 4000`、`MAX_VOICE_DIRECTION_LENGTH = 1000`。

## 3. v2 冻结契约

`VOICE_PROTOCOL_VERSION_V2 = 2`。已冻结（类型 + 运行时校验器 + 有界编码器 + 确定性测试）；运行时实现在 `src/v2-streaming.ts`。

**v2 没有自己的握手。** 认证复用 v1 `hello`：认证通过后的同一 socket 上，既能收 v1 请求，也能被识别为 v2 帧。帧识别只依赖「已认证 + v2 校验器通过」，不存在单独的 upgrade 标记。

### Envelope（每条 v2 消息必带）

```ts
{ protocolVersion: 2; sessionId: string; connectionEpoch: number; timestampMs: number }
```

### 请求

| type | 字段 |
| :--- | :--- |
| `stream_speech_chunk` | `requestId`, `speechJobId`, `chunkIndex`, `deltaText`, `isFinalChunk`, `voiceProfile?`, `deadlineMs` |
| `cancel_speech` | `requestId`, `speechJobId?`, `reason` |
| `cancel_capture` | `requestId`, `reason` |
| `stop_all` | `requestId`, `reason` |

### 事件（服务端主动推送，无轮询）

| type | 字段 |
| :--- | :--- |
| `final_transcript` | `sourceEventId`, `inputId`, `text`, `locale`, `providerId`, `actualFormat` |
| `playback_observation` | `speechJobId`, `audioEndMs`, `truncatedText?`, `terminalStatus` |
| `gateway_state` | `state: VoiceGatewayPublicState` |

`VoiceGatewayPublicState`（脱敏，绝不泄露设备名或内部诊断）：

```ts
{
  ready: boolean;
  capture: "ready" | "unavailable" | "denied";
  speech: "ready" | "unavailable" | "denied";
  reasonCode?: "ok" | "device_missing" | "permission_denied" | "quarantined" | "quarantined_cleanup_failed";
}
```

### 终态枚举

```text
not_accepted | accepted_running | completed | cancelled |
failed_before_side_effect | unknown_after_admission | quarantined
```

`failed` 不折叠不同结果：`failed_before_side_effect` 表示未产生副作用的失败；`unknown_after_admission` 表示已准入且可能有部分副作用，**禁止盲目重试**。

### 服务端准入规则（`v2-streaming.ts`）

请求在下列任一情况被拒绝为 `not_accepted` 并附原因：`stale_connection_epoch`、`timestamp_out_of_window`（±30s）、`quarantined`、`already_final`、`chunk_index_out_of_order`、`deadline_mutation`、`speech_job_limit`、`first_chunk_index`、`deadline_expired`、`chunk_too_large`。文本累计超 `MAX_JOB_TEXT_LENGTH` 时结算为 `failed_before_side_effect / text_too_long`。

### 播放观测的诚实性

`playback_observation` 只在**设备真正播完**时推送（pacing：微块按约 20ms 设备节奏供给，启动仅有限预灌），不在写入管道时提前触发。`audioEndMs` 由实际播放字节数换算。

## 4. 重放决议（v1 与 v2 共用语义）

网关维护有界去重缓存（容量 1000、TTL 60s）：

```text
same epoch + same requestId + same payload   → 幂等重放原始响应 / 当前终态
same epoch + same requestId + different payload → 拒绝 request_id_reuse
unknown_after_admission                       → 禁止盲目重试；走收据确认或降级为文字
仅权威 not_accepted                            → 允许重投完全相同的信封
```

## 5. 版本共存规则

- v1 契约保持不变；v2 是 additive（`index.ts` 只增加 `./v2.js` re-export）。
- 两个版本的校验器互斥：v1 拒绝 v2 帧，v2 拒绝 v1 帧。
- 破坏性替换必须先冻结新契约并同步两端，不做静默降级。

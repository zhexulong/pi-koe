# Provider

Provider 全部通过同一套窄接口接入，彼此不可静默替换。

## 1. 接口

```ts
interface AsrProvider { /* transcribe(finalizedAudio...) */ }
interface TtsProvider { readonly ready: boolean; readonly capabilities: { perUtteranceDirection: boolean }; }
interface Mixer       { readonly ready: boolean; play(jobId, epoch, pcm16): void | Promise<void>; stop(): void; }
```

Fake ASR / TTS / mixer 只用于确定性测试，**严禁**进入真实发布路径。缺少真实 provider 时网关保持 `unavailable` 并纯文字降级，不伪造语音可用。

## 2. MiMo TTS（云端）

| 项 | 值 |
| :--- | :--- |
| endpoint | `https://api.xiaomimimo.com/v1/chat/completions`（固定 origin；仅测试可覆盖为 loopback） |
| 模型 | `mimo-v2.5-tts` |
| 输出格式 | **24000 Hz mono PCM16LE** |
| 认证 | `api-key` 或 Bearer；key 由调用方持有，网关不读取仓库文件、不记录 |

### 采样率转换

provider 输出 24 kHz，线缆与设备契约是 16 kHz。`pcm-resampler.ts` 在 **provider 边界**做线性重采样（24k→16k）。之前跳过这一步的表现是「脉冲式杂音」——数据被当作 16 kHz 播放，速度与音高都不对。

### 官方音色（白名单）

`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。构造期对未知音色 fail-fast（`mimo_voice_unknown`），绝不把非法值发给 provider；空配置以 `mimo_voices_not_configured` 拒绝。

`MIMO_TTS_VOICE_METADATA` 提供面向操作者的参考信息（语言 / 性别 / 音色描述），不作强制。

### Persona（角色卡适配点）

`MIMO_TTS_PERSONAS` 把一个**官方音色 + 一段有界自然语言风格提示**绑定为具名人格，例如：

| persona id | voice | 说明 |
| :--- | :--- | :--- |
| `soft_maid` | 冰糖 | 慢半拍、软糯可爱的少女语气 |
| `gentle_maid` | 茉莉 | 温婉知性、轻声细语、治愈系 |
| `energetic_youth` | 苏打 | 阳光元气、轻快少年 |
| `steady_mature` | 白桦 | 沉稳磁性、从容淡定 |

角色卡侧（Host）只选择 persona id，本层解析成确切的 voice + style 字符串，调用方不需要手工拼装。显式 `voiceByProfile` / `styleByProfile` 仍可覆盖 persona。未知 persona 同样 fail-fast。

**MiMo 原生吃掉括号标签**：`(...)` / `[...]` 在文本任意位置会被 MiMo 解释为语气、情绪、呼吸、笑声、咳嗽等音频标签且不会被播出。因此 LLM 输出可以原样送 MiMo，**不需要**情绪标签提取 / 改写 / 剥离管道。注意区分：这说的是 MiMo 的**短标签**；长句动作旁白另见下节。

### 启动探针（readiness 不靠声明）

`ready` 只有在**真实 PCM 完成一次真实设备写入**后才为 true：

1. 合成一个极短的非玩家台词（`。`）；
2. 把首帧 PCM 写入 mixer（真实打开设备并写入）；
3. 成功后才 `markReadyAfterProbe()` 并投影 `voice ready`。

网关启动日志区分 `listening`（协议就绪）与 `voice ready`（provider + 设备就绪）。失败即 `voice unavailable`。

## 3. 可朗读文本提取（speakable-text）

角色卡 `first_mes` 与 LLM 输出常混有旁白。**Voice 层**负责只朗读角色真正说出的内容：

| 输入 | 处理 | 理由 |
| :--- | :--- | :--- |
| `*动作描写*`（含跨行） | **剥离** | SillyTavern 约定：星号内是动作 / 旁白，不应被朗读 |
| `**强调**` | 保留 | 强调语义 |
| 短括号 `(轻声)` / `[笑]` | **保留** | MiMo 原生情绪标签（判据：长度 ≤ `MAX_TAG_LENGTH = 12` 且不含标点 / 符号） |
| 长括号 `(翻出记事本,笔尖轻点)` | **剥离** | 句子级动作旁白，不是标签 |
| 纯符号行 | 剥离 | 噪声（`SYMBOL_NOISE_RE`） |
| 代码围栏内容 | 剥离 | 逐行状态机 |

`streaming-chunker.ts` 在**流式分句层**做同样的动作块剥离（带跨 delta 状态），因此生产路径与门禁脚本同时受益，不依赖调用方预清洗。

## 4. Groq Whisper（云端 ASR，可选）

| 项 | 值 |
| :--- | :--- |
| endpoint | `https://api.groq.com/openai/v1/audio/transcriptions` |
| 模型 | `whisper-large-v3-turbo` |
| prompt | `WHISPER_PROMPT_PRESETS`（`ZH_SIMPLIFIED` / `EN`）+ `withDomainTerms()`；`GAMEBUDDY_WHISPER_PROMPT` 可免编译覆盖 |

prompt 只做语境引导：中文默认引导输出简体并保留英文原文。**不注入系统指令**，不改变转写 authority。

凭据不进入网关日志；错误响应脱敏（只保留分类，不回显 provider 文本）。

## 5. SenseVoice（本地 ASR，可选）

`SenseVoiceCliAsrProvider` 走外部 CPU-only Fun-ASR native GGUF runtime：

- 运行前必须提供 JSON 资产清单（native 可执行、audio encoder GGUF、llama.cpp decoder GGUF、FSMN-VAD），锁定 revision 与三个 GGUF 的 SHA-256；`auditSenseVoiceAssets()` 校验路径与哈希。
- 模型本身与权重**不**打包、不静默下载。没有清单时保持 fake-ASR 文本安全模式，而不宣称本地 ASR 可用。
- PCM 转成临时 WAV，成功 / 失败 / 取消后都删除。
- 模型可能输出语言 / 事件 / 情绪 metadata tag——适配器**只保留 ASR 文本**，绝不把 tag 用于情绪、身份、同意或关系推断。

## 6. 凭据与玩家授权（两者不同）

| 概念 | 含义 | 谁能提供 |
| :--- | :--- | :--- |
| Credential | `MIMO_API_KEY`、`GROQ_API_KEY` | 操作者 / 环境 |
| IPC token | `GAMEBUDDY_VOICE_TOKEN` | 启动方（本地环回认证） |
| **Cloud speech admission** | 玩家对云端语音的同意 | **产品层**（GameBuddy Desktop supervisor） |

**key 不是 consent。** 网关只有在启动时收到一次性 launch contract

```text
GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION=desktop-consent-v1
```

才会构造 MiMo provider；直接 `pnpm start` 或缺少该值的子进程保持纯文字。这是一个**进程启动 seam**，不是 v2 线缆消息，也不表示当前 UI 已提供同意流程。

凭据本身绝不进入日志、浏览器、产品配置或游戏存档。

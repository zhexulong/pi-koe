# pi-koe 文档

`pi-koe` 是 GameBuddy 的独立语音网关仓库：本机环回、token 认证、只拥有音频捕获 / 转写 / 合成 / 播放。它同时是 **pi 扩展**（`/voice` 命令族）与 **GameBuddy 的 voice 依赖源**（submodule + 版本化协议包）。

## 读什么

| 文档 | 内容 |
| :--- | :--- |
| [architecture.md](architecture.md) | 分层、进程模型、生命周期、取消与 epoch、降级策略 |
| [protocol.md](protocol.md) | v1 存续契约与 v2 冻结契约、NDJSON framing、重放决议 |
| [windows-audio.md](windows-audio.md) | WaveOut 常驻渲染、WaveIn PTT 采集、PowerShell 解析、pacing 与 gap 断言 |
| [providers.md](providers.md) | MiMo TTS、Groq Whisper、SenseVoice、凭据与玩家授权边界 |
| [gates.md](gates.md) | 五级证据模型、无人测试方法、门禁脚本清单、已知问题 |
| [integration.md](integration.md) | 作为 pi 扩展 / 作为 GameBuddy submodule 的双重契约、CI、发布策略 |

GameBuddy 侧的权威边界（Voice 与 Chat / Game 的所有权划分）由 GameBuddy 设计仓库的 `domains/voice/overview.md` 拥有，本文档集不重复该内容。

## 当前状态

- **产品范围**：受管 Push-To-Talk（可见按键说话）+ 云端或本地 TTS 朗读。免提 OpenMic、持续 VAD、唤醒词、系统音频环回与 AEC3 **不属于当前范围**。
- **协议**：v1 是生产唯一有效协议；v2 已冻结（类型 / 校验器 / 有界编码器 + 确定性测试），其运行时（`V2StreamingRuntime`）已落地并通过真实设备验证。
- **不做**：in-game overlay、多角色音色分发、情绪标签提取管道、声卡混音 / AEC3 外放回避。
- **未闭合**：L5 玩家发布门禁（需真人说话采样）；流式 ASR 上行（边录边转写）保持 Phase 2。

## 维护规则

- 只写「当前行为 + 为什么」，不重演决策过程；详细演进放 PR 描述或 Git 历史。
- 证据文件（`scripts/pipeline-*.json`、`*.wav`）不入库，门禁可自由重写。
- 改动这里的行为时，同步检查 [gates.md](gates.md) 的断言与脚本是否仍成立。

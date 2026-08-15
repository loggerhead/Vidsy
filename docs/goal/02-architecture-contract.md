# 架构契约

## 目标结构

下载系统必须形成以下单向流程：

```text
captured source
  -> media probe
  -> MediaDescriptor
  -> capability planner
  -> MediaProcessingPlan
  -> transport/executor
  -> OutputArtifact
  -> artifact validation
  -> browser download
```

上游只能补充事实，下游只能消费计划。执行器不得在运行中根据站点、URL 命名或偶然错误重新决定另一套策略。

## 领域模型

### MediaDescriptor

`MediaDescriptor` 是输入媒体事实的唯一结构化表示，至少应覆盖：

- 输入形态：HLS、DASH、direct file、separate tracks；
- 分段/容器：MPEG-TS、fMP4/ISO BMFF、WebM/Matroska、MP3/AAC 等；
- 每条轨道的 `type`、`codec`、必要 codec parameters；
- 是否加密以及加密类型；
- 是否包含初始化段；
- 估算或已知总时长、总字节；
- 探测证据来源和置信状态。

未知字段保持未知。不得把未知 codec 默认解释为 H.264，也不得从 URL 中的 `hevc`、`h264`、扩展名或主机名生成权威事实。

### MediaCapabilities

`MediaCapabilities` 描述当前打包 WASM 与浏览器运行时实际具备的能力，至少包括：

- 可读取的 demuxer/format；
- 可识别或解析的 codec；
- 可写出的 muxer/container；
- 可用 bitstream filter；
- 允许的转码器；
- 输出设备和输入协议能力。

能力声明必须来自构建配置和启动时可验证事实。不得让 TypeScript 声明比 WASM 实际能力更宽。

### MediaProcessingPlan

planner 的输出必须是可判别联合类型，不得使用松散的参数拼装。建议至少包含：

- `copy-to-mp4`
- `copy-to-webm`
- `concatenate-fmp4`
- `transcode-audio-to-mp3`
- `unsupported`

可执行计划必须携带：

- 输入轨道选择；
- 目标容器、扩展名和 MIME；
- 是否需要预取到 OPFS；
- 所需 demuxer、muxer、codec 和 bitstream filter；
- 完成后应存在的轨道与 codec；
- FFmpeg/libav 参数或生成参数所需的结构化字段。

`unsupported` 必须包含稳定的机器原因码和面向用户的说明，例如：

- `unsupported-input-container`
- `unsupported-video-codec`
- `unsupported-audio-codec`
- `incompatible-output-container`
- `missing-required-track`
- `drm-protected`

## 探测契约

### 分层探测

按成本从低到高收集事实：

1. manifest/MPD 声明；
2. HLS `EXT-X-MAP`、DASH initialization metadata；
3. 首个媒体段的有界探测；
4. 仅在事实仍不足以规划时调用 libav probe。

探测必须有字节上限、超时和取消信号。禁止为“识别格式”下载完整媒体。

### HLS

HLS 适配器必须区分 master playlist 与 media playlist，并识别：

- MPEG-TS segments；
- fMP4 segments；
- AES-128 与不支持的 DRM/加密；
- 音视频复用流与分离 rendition；
- manifest 声明 codec 缺失时的首段探测需求。

MPEG-TS 分片不能仅因扩展名为 `.ts` 就假定 H.264/AAC。

### DASH

DASH 适配器必须把 representation 与轨道事实交给 planner。选择最高码率 representation 之前，必须先排除当前 capability 无法处理或目标容器无法承载的组合。

### Direct 与 Separate Tracks

直接文件和分离音视频轨同样经过 planner。现有 merged 下载不得绕过 capability 检查后直接固定输出 MP4。

## 规划契约

planner 必须是无网络、无存储、无浏览器 API 的纯逻辑模块，可由 fixture 单测穷举。

规划优先级：

1. 用户明确请求的输出语义；
2. 无损保留全部必要轨道；
3. 浏览器普遍可识别且与 codec 兼容的容器；
4. 最少处理步骤；
5. 最低临时磁盘和内存放大。

首期必须支持：

| 输入 | 输出计划 |
| --- | --- |
| H.264 + AAC in MPEG-TS HLS | `copy-to-mp4` |
| HEVC + AAC in MPEG-TS HLS | `copy-to-mp4` |
| H.264/HEVC + AAC in fMP4 HLS | `concatenate-fmp4` 或经证明必要的 `copy-to-mp4` |
| H.264/HEVC + AAC DASH tracks | `copy-to-mp4` |
| VP9 + Opus WebM | `copy-to-webm` |
| 用户请求 MP3 且存在可解码音轨 | `transcode-audio-to-mp3` |

AV1、Vorbis 及更多组合可纳入首期 WASM，但只有验证矩阵具备真实 fixture 时才属于承诺范围。

## WASM 能力契约

构建一个精简、可复现的 `web-media-remux` libav.js 变体。首期能力下限：

- demuxer/format：HLS、MPEG-TS、MOV/MP4、DASH、Matroska/WebM、AAC、MP3；
- codec/parser：H.264、HEVC、AAC、VP9、Opus、MP3；
- muxer：MP4、WebM、MP3；
- bitstream filter：实际 fixture 证明所需的 H.264、HEVC、AAC 转换；
- protocol/device：现有 `jsfetch` 和 OPFS writer；
- encoder：仅保留 MP3 目标所需编码器。

视频 encoder 不得进入产物。若 stream copy 的探测路径确实要求 decoder，可包含对应 decoder，但文档必须区分“识别/解析需求”和“执行视频转码”。

WASM 文件名、`LIBAV_VARIANT`、类型声明和 NOTICE 必须由同一变体名称驱动，避免旧名称残留造成能力漂移。

## 执行契约

### 统一执行入口

HLS、DASH、HTTP 和 merged 适配器不得直接拼接最终 FFmpeg 参数。它们调用 planner，并把计划交给统一 executor 或共享的严格参数生成器。

### OPFS 所有权

- 下载 worker 是 OPFS 写入权威；
- 文件大小必须在关闭会移除内存状态的句柄之前读取，或从最终 `File.size` 读取；
- 输入、输出和临时文件的所有权转移必须显式；
- 成功前不得删除输出；
- 失败和取消必须清理不再可恢复的产物；
- pause/resume 只能保留经过一致性验证的部分输入。

### 错误传播

libav 非零退出码、worker 异常、空输出和产物校验失败必须沿同一错误通道返回后台队列。不得把“浏览器接受了 blob URL”视为媒体处理成功。

## 产物契约

executor 返回 `OutputArtifact`，至少包含：

- OPFS 名称或受控 blob URL；
- `size`；
- container；
- extension；
- MIME；
- 实际轨道摘要；
- 对应 plan ID/类型。

在调用 `chrome.downloads.download` 前必须验证：

1. `size > 0`；
2. container 与 extension/MIME 一致；
3. 计划要求的音视频轨存在；
4. codec 与计划一致；
5. 时长在可解释范围内；
6. 不包含探测器已判定的 DRM。

浏览器下载完成后才记录最终 success。媒体处理完成与浏览器落盘完成应是两个不同状态；若暂不扩展状态枚举，至少不得在 `chrome.downloads.download` 返回 ID 时立即写 success。

## 可观测性

每次处理记录结构化诊断，至少包含：

- descriptor 摘要；
- 选定 plan 与原因；
- capability 版本/变体；
- transport 模式；
- libav 退出码；
- 输出大小、容器和轨道摘要；
- 稳定失败原因码。

日志不得包含完整签名 URL、Cookie、Authorization 或其他敏感请求头。

## 禁止的架构捷径

- host/domain 条件分支；
- provider-specific extractor 作为 codec 兼容层；
- URL 字符串替换 codec 或清晰度；
- “失败后保存原分片并改成 `.mp4`”；
- HLS/DASH/merged 各自维护独立 codec 表；
- 未经 planner 的隐式视频转码；
- 仅凭文件非空判定成功。

# 验证与验收

## 验证原则

验收以仓库 fixture、媒体探针和真实扩展端到端结果为准。网络站点只用于发现问题和补充证据，不作为可重复测试的依赖。

每个 fixture 必须记录：

- 来源与再分发/使用许可；
- 生成或裁剪方法；
- 输入 container、codec、轨道和时长；
- 预期计划；
- 预期输出 container、codec 和轨道；
- 允许的时长与大小误差；
- 是否包含加密、初始化段或分离轨道。

fixture 应足够短以便本地和 CI 运行，同时保留触发真实 demux/remux 行为所需的头、关键帧和音视频轨。

## 必选 fixture 矩阵

| ID | 输入 | 预期计划 | 预期结果 |
| --- | --- | --- | --- |
| HLS-TS-H264 | MPEG-TS HLS, H.264 + AAC | `copy-to-mp4` | MP4，H.264 + AAC |
| HLS-TS-HEVC | MPEG-TS HLS, HEVC + AAC | `copy-to-mp4` | MP4，HEVC + AAC |
| HLS-FMP4 | fMP4 HLS, MP4-compatible tracks | `concatenate-fmp4` 或经证明必要的 `copy-to-mp4` | 有效 MP4 |
| DASH-AV | DASH，分离视频与音频 | `copy-to-mp4` | 单个 MP4，双轨完整 |
| HTTP-MP4 | direct MP4 | direct/copy plan | 容器与输入一致 |
| MERGED-AV | 分离 direct video/audio | compatible copy plan | 单文件，音视频完整 |
| WEBM-VP9 | WebM, VP9 + Opus | `copy-to-webm` | WebM，VP9 + Opus |
| AUDIO-MP3 | 可解码音轨，用户请求 MP3 | `transcode-audio-to-mp3` | MP3，存在音轨 |
| DRM | 不支持的 DRM manifest | `unsupported` | 执行前失败 |
| EMPTY | 空响应或空输出 | failure | 不创建成功记录 |
| TRUNCATED | 截断媒体段 | failure | 产物校验失败 |
| MISSING-TRACK | 计划要求双轨但缺一轨 | `unsupported` 或 failure | 不生成成功文件 |

AV1、Vorbis 或更多组合只有在加入对应 fixture、planner 断言和 E2E 后，才能写入公开支持矩阵。

## 分层测试

### 1. 构建能力测试

对生成的 WASM/CLI wrapper 验证：

- 变体名称与文件名一致；
- 所需 demuxer、muxer、codec/parser、bitstream filter 可用；
- 禁止的视频 encoder 不存在；
- `ffmpeg`、`mkwriterdev`、`jsfetch` 和 terminate API 可调用；
- NOTICE 与构建配置一致。

完成标准：能力声明与二进制实际能力逐项匹配。

### 2. 探测器测试

使用 manifest、init segment 和首段 fixture 验证：

- 正确识别 MPEG-TS 与 fMP4；
- 正确识别 H.264、HEVC、VP9、AAC、Opus；
- manifest 缺少 codec 时能通过有界探测补齐；
- 冲突元数据产生稳定诊断；
- 超时、取消和字节上限有效；
- DRM 在执行前被拒绝。

完成标准：每个必选 fixture 生成精确、稳定的 `MediaDescriptor`。

### 3. Planner 单元测试

对 descriptor 与 capabilities 的笛卡尔关键子集做表驱动测试：

- 支持组合生成唯一计划；
- 不支持组合生成精确原因码；
- codec 相同但 container 不同会得到不同必要步骤；
- capability 缺失会改变结果为 `unsupported`；
- 用户请求 MP3 不触发视频转码；
- extension/MIME/container 一致。

完成标准：planner 分支全部有断言，且测试不依赖浏览器或网络。

### 4. Worker 集成测试

在真实 worker/OPFS 环境运行每个可执行计划，验证：

- 输入写入、随机偏移输出和 flush 正确；
- `ffmpeg` 非零退出码被传播；
- 输出 size 在句柄生命周期内正确读取；
- 取消会终止所有同 job controller；
- 临时输入和输出按所有权清理；
- 并发下载不串 job ID、进度或 OPFS 名称。

完成标准：worker 返回可验证的 `OutputArtifact`，失败路径无孤儿产物。

### 5. 产物探针

使用独立于被测 WASM 的探针检查最终文件：

- `size > 0`；
- format/container；
- 每条轨道 codec 和 type；
- 时长；
- 音视频轨数量；
- 首尾可解码时间范围或等价完整性信号。

独立探针优先使用系统 `ffprobe`；CI 环境不可用时使用固定版本的独立 parser。不得用同一个 libav 实例既生产又证明自身输出正确。

完成标准：输出符合计划，且时长误差不超过 fixture 定义的界限。

### 6. 扩展端到端测试

在加载 unpacked 生产构建的隔离 Chrome profile 中验证：

1. 页面或本地 fixture server 触发通用网络检测；
2. UI 展示媒体；
3. 用户开始下载；
4. 进度经历真实阶段；
5. 浏览器下载完成；
6. 下载目录存在非空文件；
7. 历史记录在浏览器 complete 后才为 success；
8. 独立探针验证最终文件。

HEVC 代表用例必须通过此层，不能只在系统 ffmpeg 或 Node harness 中通过。

完成标准：从检测到磁盘文件的完整链路无需站点专用代码。

## 回归矩阵

除新能力外，以下现有行为必须保持：

- HLS 请求头授权与跨 CDN segment；
- AES-128 HLS；
- fMP4 快速路径；
- DASH 分离轨合并；
- direct HTTP Range 与 stream fallback；
- merged A/V 并发预算；
- MP3 输出；
- pause、resume、cancel；
- 多下载并发与队列；
- OPFS GC 与 blob cleanup；
- 下载历史、Play、Show in folder；
- DRM 阻断；
- 文件名模板。

## 性能与资源预算

### 测量方法

- 同一机器、同一 Chrome 版本、同一 fixture；
- 冷启动与热启动分别测量；
- 至少 5 轮，交替运行旧/新变体以降低环境漂移；
- 报告中位数和最差值；
- 不用高频日志污染耗时和内存测量。

### 必报指标

- 原始与压缩后 WASM 大小；
- 最终 zip 大小；
- worker 首次初始化耗时；
- 首字节处理延迟；
- 总处理耗时；
- 峰值 JS/WASM 内存；
- OPFS 临时空间放大倍数；
- H.264 基线路径回归幅度；
- HEVC 新路径结果。

### 预算

实现前记录基线并在阶段 1 明确数值预算。若仓库尚无正式预算，首轮评审至少必须阻断：

- 无解释的显著包体增长；
- H.264 基线路径超过 15% 的稳定耗时回归；
- 峰值内存相对输入大小出现新的倍增；
- 为减少体积而破坏必选能力矩阵。

预算调整必须附测量证据并更新本文件，不能在实现代码中隐式接受。

## 安全与合规

交付前检查：

- 不记录完整签名 URL、Cookie、Authorization；
- fixture 不包含用户凭据或不可再分发内容；
- FFmpeg、libav.js、LAME 及新增组件许可证完整；
- 对应源码获取和重建说明可执行；
- HEVC/H.265 相关专利说明由发布负责人审阅；
- Chrome Web Store 包体与政策要求已核对；
- DRM 路径仍然只识别并拒绝。

## 失败注入

必须覆盖：

- playlist、init segment、media segment 返回 401/403/404/416/5xx；
- 响应体为空；
- Content-Length 与实际字节不一致；
- segment 中途断开；
- OPFS 空间不足；
- worker terminate；
- libav 非零退出；
- `onwrite` 写入停滞；
- 输出被截断；
- `chrome.downloads` interrupted；
- cleanup 消息丢失或延迟。

每个失败注入都必须证明：状态为失败或取消、原因可诊断、没有成功历史、没有被误命名的损坏文件。

## 最终验收清单

- [ ] HEVC + AAC MPEG-TS HLS 在扩展 E2E 中生成有效 MP4。
- [ ] H.264、fMP4、DASH、direct、merged、WebM 和 MP3 必选用例通过。
- [ ] DRM、空输出、截断和缺轨用例正确失败。
- [ ] planner 是唯一 codec/container 决策权威。
- [ ] 成功状态晚于产物验证和浏览器 complete。
- [ ] 无站点专用 extractor、host 分支或 URL codec 猜测。
- [ ] 完整测试、类型检查、生产构建和打包通过。
- [ ] 性能、内存和体积报告完成并符合预算。
- [ ] NOTICE、许可证、重建说明和公开支持矩阵与产物一致。
- [ ] 临时调试代码、外部样本和敏感日志已清理。

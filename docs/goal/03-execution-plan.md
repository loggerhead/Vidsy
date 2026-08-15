# 执行计划

## 执行规则

按阶段顺序推进。每个阶段必须满足出口条件后才能进入下一阶段；后续实现不得掩盖前一阶段尚未证实的假设。

执行期间维护一个不提交仓库的本地进度账本，记录：

- 当前阶段与未完成出口条件；
- 关键测量、命令和结果；
- 已确认与已推翻的假设；
- fixture 来源及其授权状态；
- 临时文件和调试代码的清理状态；
- 与本目标无关的既有工作区改动。

工作区存在其它改动时，只编辑、暂存和提交当前阶段明确拥有的文件。不得借本目标重排无关 UI、检测或队列代码。

## 阶段 0：冻结基线

### 工作

1. 记录当前生产构建中的 libav.js 版本、变体名称、WASM 大小和压缩后扩展包大小。
2. 固化当前成功路径的代表性 fixture：
   - H.264 + AAC MPEG-TS HLS；
   - fMP4 HLS；
   - DASH 分离音视频；
   - direct MP4；
   - merged A/V；
   - 音频转 MP3。
3. 固化当前失败 fixture：HEVC + AAC MPEG-TS HLS。
4. 建立无网络、短时长、仓库可重复运行的媒体处理 harness。
5. 记录现有路径的输出容器、codec、轨道、时长、大小、峰值内存和耗时。

### 出口条件

- HEVC fixture 在旧变体上稳定失败；
- 所有既有成功 fixture 在基线 harness 中稳定通过；
- fixture 可在不访问原站点的情况下复现；
- 基线报告包含命令、环境和实际探针输出。

## 阶段 1：构建 `web-media-remux` 变体

### 工作

1. 在固定 libav.js/FFmpeg 版本上定义显式构建配置。
2. 只启用 [`02-architecture-contract.md`](./02-architecture-contract.md) 要求的 format、codec/parser、muxer、bitstream filter、protocol、device 和 MP3 encoder。
3. 保留现有 worker 所需的 CLI wrapper、高层 API 和同步输出回调行为。
4. 用独立 smoke harness 验证：
   - `ffmpeg()` 可调用；
   - `mkwriterdev` 能写入 OPFS；
   - `jsfetch` 可读取 HTTP/blob 输入；
   - HEVC + AAC TS 可无损 remux 到 MP4。
5. 更新变体文件名、加载常量、类型声明、NOTICE、许可证和重建说明。

### 出口条件

- HEVC smoke fixture 输出有效 MP4；
- H.264、DASH 和 MP3 smoke fixture 无回归；
- 构建可从文档化命令复现；
- 仓库不存在旧变体名与新能力声明冲突；
- 体积和初始化耗时已与基线比较。

### 决策门

如果单变体体积或加载成本超出可接受范围，先测量裁剪项，再考虑双变体。双变体方案必须证明：

- 默认路径不加载扩展变体；
- capability planner 能确定性选择变体；
- 两套变体不复制业务决策；
- 额外缓存、取消和错误处理复杂度有测试覆盖。

## 阶段 2：建立描述符与探测器

### 工作

1. 定义 `MediaDescriptor`、轨道、container/segment format、encryption 和证据类型。
2. 将 manifest 元数据解析为描述符事实。
3. 对信息不足的输入增加有界首段/init segment 探测。
4. 将 HLS、DASH、direct、separate tracks 的探测结果统一到同一模型。
5. 明确未知、冲突和低置信事实的处理规则。
6. 探测器接入取消、超时和字节上限。

### 出口条件

- fixture 矩阵中的每个输入都生成稳定 descriptor；
- HEVC 判定不依赖 URL 或站点；
- manifest 声明与媒体段冲突时有确定性结果和诊断；
- 探测不会下载完整媒体；
- DRM fixture 在执行前被识别并停止。

## 阶段 3：建立 capability planner

### 工作

1. 定义 `MediaCapabilities` 和 `MediaProcessingPlan` 判别联合。
2. 实现纯函数 planner。
3. 集中维护 codec/container 兼容矩阵。
4. 为每个 `unsupported` 分支定义稳定原因码。
5. 定义目标扩展名和 MIME 的单一映射。
6. 为 MP4、WebM、fMP4 直拼和 MP3 计划生成结构化执行参数。

### 出口条件

- planner 不导入网络、Chrome、OPFS 或存储模块；
- 必选矩阵的每个 descriptor 都有精确单测；
- 相同输入与 capability 始终产生相同计划；
- 不兼容组合不会生成可执行计划；
- 扩展名、MIME 和 container 由计划统一决定。

## 阶段 4：统一执行器

### 工作

1. 建立消费 `MediaProcessingPlan` 的共享 executor。
2. HLS、DASH、HTTP 和 merged 适配器只负责准备输入和委派执行。
3. 把 FFmpeg 参数生成移到计划执行层。
4. 保持 worker 为 OPFS 写入权威，明确临时输入和最终输出所有权。
5. 统一退出码、取消、超时、磁盘不足和 worker 崩溃的错误传播。
6. 保留现有进度能力，但使阶段与真实执行步骤一致。

### 出口条件

- 四类入口均通过 planner/executor；
- 不存在第二套 codec/container 决策表；
- HEVC HLS 在扩展 worker 中生成有效 MP4；
- 取消和失败不会泄漏不可恢复 OPFS 文件；
- pause/resume 只作用于经过一致性校验的输入。

## 阶段 5：产物验证与成功状态

### 工作

1. 定义 `OutputArtifact`。
2. 在创建浏览器下载前验证 size、container、轨道、codec 和时长。
3. 将媒体处理完成与浏览器落盘完成分开。
4. 仅在 `chrome.downloads` 报告 complete 后记录最终 success/history。
5. interrupted、校验失败和 cleanup 失败分别记录稳定诊断。
6. 确保失败产物不会作为成功文件留在下载目录。

### 出口条件

- 非零退出码、0-byte、错误容器、缺轨和截断 fixture 全部失败；
- `chrome.downloads.download` 仅返回 ID 时不会提前 success；
- complete 后才允许清理 blob URL 与最终 OPFS；
- 历史记录与磁盘实际状态一致。

## 阶段 6：集成与发布门

### 工作

1. 运行 [`04-validation.md`](./04-validation.md) 全矩阵。
2. 比较包体、初始化耗时、处理耗时和峰值内存。
3. 审计许可证、源码获取说明、专利说明和第三方 NOTICE。
4. 更新 README 的支持矩阵与限制。
5. 删除临时日志、下载的外部样本和未引用实验代码。

### 出口条件

- 所有必选验证通过；
- 生产构建和打包通过；
- 性能与体积差异有证据且达到预算；
- 文档与实际能力一致；
- 无站点专用兼容分支；
- 工作区只包含本目标的预期改动。

## 回退策略

每阶段应保持可单独回退：

- 新 WASM 在 planner 接入前不替换生产 authority；
- descriptor/planner 可先以旁路诊断模式运行，与旧策略对比但不双写下载状态；
- executor 切换必须是单一开关或原子替换，不长期保留两套生产路径；
- 产物验证一旦启用不得因兼容压力降级为警告。

禁止长期 dual-write、按站点 fallback 或“新路径失败后静默走旧路径”。迁移期对比只能用于测量，不能成为发布后的运行时架构。

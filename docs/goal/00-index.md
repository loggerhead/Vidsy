# 通用网页媒体 Remux 能力目标

## 指令

本目录是“让 Vidsy 通用处理常见网页媒体编码与容器”的目标权威。执行者必须先阅读本文件，再按当前工作阶段加载对应文档。不得以站点专用 extractor、站点 URL 改写或隐藏备用流解析代替本目标。

## 文档路由

1. 开始或恢复任务时，阅读 [`01-objective.md`](./01-objective.md)，确认目标、非目标和完成定义。
2. 设计或修改下载链路、libav、OPFS、容器选择时，阅读 [`02-architecture-contract.md`](./02-architecture-contract.md)。
3. 安排实现顺序、阶段提交或恢复未完成工作时，阅读 [`03-execution-plan.md`](./03-execution-plan.md)。
4. 增加测试、运行验证或判断能否交付时，阅读 [`04-validation.md`](./04-validation.md)。

## 权威顺序

发生冲突时按以下顺序裁决：

1. 可重复测试和真实媒体探针结果；
2. [`02-architecture-contract.md`](./02-architecture-contract.md) 的运行时契约；
3. [`01-objective.md`](./01-objective.md) 的产品边界；
4. [`03-execution-plan.md`](./03-execution-plan.md) 的建议顺序。

实现细节可以随证据调整，但不得降低完成定义或绕过架构契约。若新证据推翻既有假设，先更新对应目标文档，再继续实现。

## 当前基准问题

已确认的代表性失败是：网页提供 `HEVC + AAC` 的 MPEG-TS HLS，Vidsy 能捕获并下载非空分片，但当前 `h264-aac-mp3` libav.js WASM 无法完成处理；旧链路曾忽略媒体处理器非零退出码并生成 0-byte MP4。

该案例是通用能力缺口的验收样本，不是引入 AcFun 特例的理由。

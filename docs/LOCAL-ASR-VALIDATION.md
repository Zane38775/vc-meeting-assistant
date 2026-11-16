# 本地实时转写验证

验证日期：2026-11-16。结论仅适用于下述 Windows 主机和公开样例；尚无 Apple Silicon 真机、真实会议、麦克风、系统声音或连续 60 分钟的验证证据。

## 实现

- 默认 `ASR_PROVIDER=local`。仅明确设置 `ASR_PROVIDER=tencent` 才启用旧腾讯云转写；模型缺失、加载失败、超时和积压均不会回退到云端或演示。
- `sherpa-onnx-node@2.0.1` N-API 原生运行库；推理在独立 Node Worker 中运行，服务的 HTTP/WebSocket 线程不执行 ONNX 推理。
- 中英混合 streaming Zipformer small，默认 chunk size 32，CPU 两线程，encoder INT8 / decoder FP32 / joiner INT8；16 kHz、单声道 PCM16LE 输入，200 ms 音频帧。
- 增量结果即时发出；端点规则为静音 2.4 秒、发言后静音 1.2 秒、最长单段 20 秒。停止时额外输入 0.8 秒零值以排空右侧上下文，再通知 inputFinished；人工补零不计入时间戳。
- 最多两路本地 Worker；未确认音频最多 5 秒；模型启动期限 20 秒、处理确认期限 8 秒、结束期限 15 秒。取消或异常会终止 Worker 并释放队列。
- 本模型不包含说话人分离，输出明确标记“发言者（本地未分离）”；时间戳是分段音频范围，不是逐词人工标注。

## 主机和输入

Windows x64，AMD Ryzen 7 9800X3D（8 核、16 逻辑处理器），63.66 GiB 内存。Node 24.14.0。测试不打开麦克风、不播放声音，只读取官方模型包附带 WAV。

模型说明：[官方预训练模型文档](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16-bilingual-chinese-english)。模型来源和 Apache-2.0 声明保存在 `models/local-asr/MODEL-CARD.md`；原始文件：[固定提交的模型卡](https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t/raw/e2382758de9a0219b4efe682b95af30b399db3b8/README.md)。

原始归档：`sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2`，458187351 字节，SHA256 `2b7c63322b32e5e0f2526043a1103366119ca58dd615cd7105a37c01db9553d7`。所需四个运行时文件合计 60142871 字节；各文件、两个样例的大小与 SHA256 均保存在 `MODEL-PROVENANCE.json`，下载脚本会逐个验证。

## 真实样例推理

首轮加速输入：10.053125 秒的 `test_wavs/0.wav`，每 40 ms 提交 200 ms 音频，包含模型加载总耗时 2436 ms，14 次增量更新。服务主线程的 10 ms 心跳触发 232 次。这个数值反映本机短样例处理能力，不是端到端麦克风延迟或完整实时率基准。

随后按捕获时序每 200 ms 提交对应音频；第一帧在模拟音频开始 200 ms 后提交。以下是一次测量，未经多轮统计：

| 样例 | 时长 | 模型启动 | 首个非空增量 / 音频开始 | 首个增量 / 首帧提交 | 最终稿 / 末帧提交 | 增量数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `test_wavs/0.wav` 中英混合 | 10.053 s | 403 ms | 1205 ms | 1006 ms | 12 ms | 14 |
| `test_wavs/1.wav` 中文为主、含英文 | 5.100 s | 361 ms | 1404 ms | 1205 ms | 12 ms | 9 |

最终识别输出（保留模型实际输出，未人工修正）：

1. `昨天是 MONDAY TODAY IS THEY AFTER TOMORROW是星期三`
2. `这是第一种第二种叫呃与 ALWAYS什么意思啊`

第二个样例并非纯中文。未提供逐字人工真值对齐，不据此报告字错率、识别准确率或会议效果。首个增量包含样例开始处的静音、模型上下文和捕获分帧等待；末尾 12 ms 是明确停止后的排空耗时，不能替代自然停顿的 1.2 秒端点等待。

## 可重复执行

```powershell
node scripts/download-model.mjs
npx tsx --test tests/local-asr.test.ts
$env:RUN_LOCAL_ASR_REALTIME='1'
npx tsx --test --test-name-pattern='real-time 200ms' tests/local-asr.test.ts
```

默认测试覆盖：模型缺失不回退、完整性校验、排队与结束顺序、积压、取消、启动和处理超时，以及真实原生引擎的增量/最终稿推理。另以两个真实样例中间插入 2 秒静音，验证自然停顿在停止调用之前生成最终稿，后续发言继续识别，最终句 ID 不重复且时间范围保持顺序。实时节奏测试显式选择运行，避免每次快速测试增加约 16 秒。

## Apple Silicon 交付边界

官方发布 `sherpa-onnx-darwin-arm64@2.0.1`（N-API）；包中必须保留其 `.node` 与 `.dylib`，解包至磁盘，2.0.1 版二进制经静态检查包含 @loader_path 搜索路径，同目录解包即可发现附带 dylib；旧[官方 Node 示例说明](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md)中的额外动态库路径设置不作为此包的依赖。模型作为资源随应用交付，首次使用无需下载。Windows 上的推理测试不能证明 Apple Silicon 安装、加载、录音权限或系统声音捕获成功；这些仍须 Mac 真机验收。

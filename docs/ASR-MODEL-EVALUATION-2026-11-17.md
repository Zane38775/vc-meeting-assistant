# 本地 ASR 候选对比 · 2026-11-17

## 触发与范围

Apple M1 / 16 GiB / macOS 27.0.1 / 原生 Node24.22.3。候选0.1.1-beta.1已从真实BP载入 `home party`，但真人测试仍转成“红 PARTY”，`ACE-Step`（BP原文不存在）转成“A STEP”。因此比较替换模型，而不把术语提示或文本替换当作准确性修复。

以下全部是公开WAV或系统合成语音的工程对照，不是新的真人会议验收，也没有计算通用准确率。用户暂时无法参与，真人中英文、腾讯双端和60分钟真实会议仍待验证。

## 模型比较

| 配置 | 本机结果 | 工程取舍 |
|---|---|---|
| 原 Zipformer small + 术语 | 3段合成英文共44个参考词，9次编辑；真人已发现英文错误 | 约57.4 MiB运行模型，保留为明确回退选项 |
| X-ASR 480ms INT8（现有sherpa 2.0.1） | 同3段英文2次编辑；两段混语结构和标点改善；目标4段 `home party` 4/4，`ACE-Step` 仍通常为 `A step` | 真流式，约161.4 MiB；优先接入并继续验收 |
| Whisper large-v3-turbo Q5 / whisper.cpp v1.9.5 | 同一3.74秒合成英文，Metal服务耗时21.74秒；no-Flash Metal CLI冷启动+解码46.57秒；CPU CLI52.10秒。三次均漏成 `A-Step` / `A Step` | 不同入口/束搜索设置，不能据此单独评估Flash效果；本组配置明显慢于实时，未选择为本场流式默认 |
| Fun-ASR Nano GGUF / 官方mac arm64 v0.1.10 | 权重和程序SHA通过，五段合成输入均SIGILL，无结果。故障指令是 `smmla`，M1不支持I8MM | 此预编译运行时minos26.0，亦不符合14.2+分发要求。仅排除本预编译组合，未评价模型准确性或自编译版本 |

Whisper首次Node客户端退出137的原因未确认；其后curl与CLI均正常返回。Fun-ASR的故障来源已定位到Q5 CPU repack内核，不把程序崩溃算作识别错误。

## X-ASR 实时节奏

同一组音频按200ms帧发送，只有一个模型实例参加该轮计时：

| 样本 | 原small+词表首条 | X-ASR首条 | 原末帧→定稿 | X-ASR末帧→定稿 |
|---|---:|---:|---:|---:|
| 10.05秒公开中英样本 | 1230ms | 1637ms | 27ms | 412ms |
| 6.10秒普通话夹英文合成样本 | 615ms | 864ms | 43ms | 230ms |

X-ASR计算实时因子0.168–0.178，最大单帧处理约161ms，单进程峰值RSS约508MiB（旧套约228MiB）。没有在这两段中落后于输入，不代表长会稳定性。热词分数/拼写实验也未稳定解决 `ACE-Step`：四段中最好只命中一段。不可据此保证英文专名准确。

## 来源与校验

- X-ASR [官方模型卡](https://huggingface.co/GilgameshWind/X-ASR-zh-en/blob/main/README.md)；[sherpa集成说明](https://github.com/k2-fsa/sherpa-onnx/blob/master/flutter/sherpa_onnx/example/example.md)。官方归档133,895,136字节，SHA256 `fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74` 与GitHub发布资产digest一致；Apache-2.0。
- Whisper [官方C++运行时](https://github.com/ggml-org/whisper.cpp)与[GGML权重](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-large-v3-turbo-q5_0.bin)。权重574,041,195字节，SHA256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` 与官方元数据一致；MIT。本机编译Metal，部署目标14.2。
- Fun-ASR [官方运行时](https://github.com/QwenAudio/Fun-ASR/releases/tag/runtime-llamacpp-v0.1.10)与[GGUF模型](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-GGUF/tree/main)。此次选F16 encoder + Q5_K_M decoder + FSMN VAD，总约1.02GB，均校验官方SHA。

安装包验收仍需区分：构建/推理链路通过、真实收音有效、识别质量达到要求。这三者不能互相替代。

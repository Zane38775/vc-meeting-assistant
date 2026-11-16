# 知投 · VC Meeting Assistant

会前上传 BP；会中本地实时转写，DeepSeek 生成有原话依据的追问并查询公开技术资料；会后整理、发布和导出纪要。

主交付为 Apple Silicon（M 系列）Mac 测试包，要求 macOS 14.2 或以上。中英文流式模型已内置，无需语音云服务密钥或首次下载。应用只需配置 DeepSeek API 才能启用智能分析，未配置时本地转写仍可用。

**[下载 Mac 测试版 v0.1.0](https://github.com/Zane38775/vc-meeting-assistant/releases/tag/v0.1.0)** · [安装说明](docs/START-MAC.md) · [Mac 开发与验收](docs/MAC-DEVELOPMENT.md) · [验证记录](VALIDATION.md)

普通使用者请下载 Release 附件 `VC-Meeting-Assistant-0.1.0-mac-arm64.zip`，内含应用、模型和安装脚本；GitHub 自动生成的 `Source code (zip)` 仅为源码，不是安装包。当前为预发布测试版，未做 Apple Developer ID 签名或公证。

![会议工作台演示截图](docs/assets/meeting-demo.png)

上图是明确标记的演示流程，使用预设对话，不代表真实识别或 DeepSeek 输出。

## 给使用者

1. 解压 Mac ZIP。按包中的《开始使用》执行 `Install-on-Mac.command`，它安装到当前用户的 Applications 并创建本机签名。没有 Developer ID 签名/公证，不要把本包当作已通过 Mac 实机验收的正式发行版。
2. 打开 VC Meeting Assistant，创建本机账号。在「服务设置」输入 DeepSeek 密钥。只有该服务首个注册账号可修改配置；密钥不会回显。
3. 新建项目，上传 PDF/PPTX/TXT/MD，核对提取页码和摘要。先配置密钥再上传才能自动生成摘要。
4. 创建真实会议，选择线下或线上；点击「开始采集」后才请求音频权限。线上模式需要麦克风与系统音频权限，并可能请求屏幕捕获权限以选择音源。不保存屏幕画面。
5. 暂定字幕会持续修订；句子确定后才触发 AI 追问。追问和搜索互相独立，不阻塞字幕。暂停/结束会等待尾句处理；失败时显示缺口。
6. 会后生成纪要，检查并发布或导出 Markdown。演示会议始终标记为演示，不会开启麦克风或调用真实分析服务。

默认不保存原始录音；转写、材料、笔记和配置存放在本机用户应用数据目录。后台默认只监听 127.0.0.1，单机包的邀请链接不能直接供异地伙伴访问。异地使用需部署共享服务；目前可直接导出纪要分享。

## 已验证与未验证

- 自动测试覆盖权限隔离、撤权断连、私人笔记、密钥保护、尾音刷新、并发控制、删除竞态、资料解析与本地模型真实推理。
- Windows 开发机上的两段 WAV 按 200ms 节奏测试，首条增量约 1.2–1.4 秒；自然分句需等待约 1.2 秒静音。完整浏览器采集链路以公开 WAV 模拟麦克风，首条字幕约 1.3 秒。均不是 Mac 实测或识别准确率指标。
- 桌面应用启动、沙盒、配置状态和受保护原文件下载已实际验证。
- 尚未验证：朋友 Mac 上的安装/本机签名、麦克风/系统声音、真实会议、60 分钟稳定性、DeepSeek 真实密钥调用、异地双设备协作。详见 VALIDATION.md 和 docs/LOCAL-ASR-VALIDATION.md。

当前限制：本地模型不自动区分说话人，支持人工修改角色；扫描页和图表不做 OCR，显示解析警告并允许补录；公开检索使用保守技术关键词表，超出词表的查询不发送；没有 AI 投资评级功能。

## 源码运行

要求 Node.js 24、npm；Windows/macOS。模型下载的源归档约 437 MiB，但实际运行模型约 57.36 MiB；下载脚本校验固定 SHA256。

```text
git clone https://github.com/Zane38775/vc-meeting-assistant.git
cd vc-meeting-assistant
npm ci
node scripts/download-model.mjs
npm run build
npm run desktop
```

网页开发可运行 `npm run dev`；生产网页服务为 `npm start`。首次设置可以在应用内完成，也可以把 `.env.example` 复制为 `.env`。不要提交或分享 `.env`。

```text
npm test
npm run typecheck
npm run package:mac
python3 scripts/archive-mac.py
```

`package:mac` 使用 Electron 官方 Packager，包含 Apple arm64 语音/PDF 运行库及模型。跨平台构建可生成 .app 目录；可信开发者签名、公证与系统音频验收需在 Mac 完成。本机签名脚本不会关闭 Gatekeeper 或移除隔离属性。

归档脚本将可分发 ZIP 和 SHA-256 校验文件写入 `release/`。在 Windows 上使用 `python` 代替 `python3`。详细的更新源码、数据位置、故障排查和 Mac 验收清单见 [Mac 开发指南](docs/MAC-DEVELOPMENT.md)。GitHub Actions 会在 Windows 与 Apple 芯片 macOS runner 上执行测试和构建；Mac 构建附件供开发验证，不等于真实会议收音验收。

## 共享服务部署

服务同样可以部署在受控的 Node 24 主机：`npm ci`、准备本地模型、`npm run build`，设置 DATA_DIR、HOST、PORT 后启动，使用 HTTPS 反向代理（需允许 WebSocket 升级）。生产部署设置 PUBLIC_ORIGIN 为唯一 HTTPS 域名、COOKIE_SECURE=true，并保护数据目录和备份。

桌面 `VC_SERVER_URL=https://你的服务域名` 可连接共享服务。在这种模式中，音频会经 WSS 发到服务部署的机器，由那台机器执行“本地模型”；不再表示音频留在参会电脑上。不要把此模式描述为端上离线识别。默认单机包没有启用或公开任何共享服务。

运行时文件：SQLite 数据库、files/ 材料目录、可选 audio/ 目录；备份时应暂停服务后一并复制，删除项目后也要按自己的备份周期清除历史副本。客户端不会持有第三方密钥。

## 技术与模型

Electron、React/TypeScript、Fastify、SQLite、AudioWorklet、WebSocket。ASR 采用 sherpa-onnx 的流式 Zipformer small（中文/英文），独立 Worker，CPU 两线程。推理/资料分析/检索使用 DeepSeek 独立接口。模型与运行库授权、来源、校验值在随包的模型资源中。

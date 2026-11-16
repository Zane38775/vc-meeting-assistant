# 在 Apple Silicon Mac 验证与继续开发

本页面向源码开发者。只想使用软件，请下载 [v0.1.0 Release](https://github.com/Zane38775/vc-meeting-assistant/releases/tag/v0.1.0) 中的 [Mac ZIP](https://github.com/Zane38775/vc-meeting-assistant/releases/download/v0.1.0/VC-Meeting-Assistant-0.1.0-mac-arm64.zip)，并按 [安装说明](START-MAC.md) 操作；Release 已内置运行时和语音模型，不需要安装 Node.js 或 Python。GitHub 自动生成的 `Source code.zip` 是源码，不是可直接打开的应用。

当前 Mac 安装、权限、真实收音与长会稳定性尚待实机验证；Windows 结果见 [验证记录](../VALIDATION.md)。请把下面清单的实际结果记录到新的验证记录，再据此更新支持范围。

## 取得源码并启动

要求 Apple Silicon、macOS 14.2+、原生 arm64 的 Node.js 24（含 npm）、Git。打包 ZIP 还需要 Python 3.8+；模型与原生依赖下载脚本使用系统 `tar`。可使用 Node.js 官方安装程序或自己的版本管理器，先确认终端未在 Rosetta 下使用 x64 Node：

```bash
node --version
node -p "process.arch"
git --version
```

前两项应分别显示 `v24.x.x` 与 `arm64`。

```bash
git clone https://github.com/Zane38775/vc-meeting-assistant.git
cd vc-meeting-assistant
npm ci
npm run model:download
npm run build
npm run desktop
```

模型下载需要联网，源归档约 437 MiB，实际运行模型约 57 MiB；脚本会验证固定大小和 SHA-256，并生成来源、许可与文件清单。后续识别本身在本机运行。`npm ci` 必须保留可选依赖，以安装 Mac arm64 的原生运行库。

打开软件后创建本机账号，在「服务设置」填写自己的 DeepSeek API Key。仅服务首个注册账号可修改密钥；不配置密钥也可先验证本地转写。分析时相关文字和材料会发送给 DeepSeek，请先用虚构项目或可公开材料验收。

需要通过环境文件配置时，可先执行 `cp .env.example .env` 后在本机编辑 `.env`。该文件被 Git 忽略；不要把密钥写进源码、Issue、日志附件或截图。修改外部环境文件后重启服务。

## 日常开发与自动检查

桌面模式读取 `dist/`：修改源码后退出应用，重新 `npm run build`，再 `npm run desktop`。窗口关闭后本地服务也会退出。默认端口为 `127.0.0.1:4318`，不要同时启动两个服务。

网页界面开发可以先退出桌面应用，再执行：

```bash
npm run dev
```

打开终端显示的 Vite 地址，默认是 `http://127.0.0.1:5173`；后端仍监听 4318。Vite 模式适合布局、项目和材料流程；Mac 系统音频与 Electron 权限逻辑必须在桌面模式验收。停止开发服务使用 `Ctrl+C`。

```bash
npm test
npm run typecheck
npm run build
RUN_LOCAL_ASR_REALTIME=1 npx tsx --test --test-name-pattern='real-time 200ms' tests/local-asr.test.ts
```

下载模型后，普通测试包含真实原生模型推理；实时节奏测试需要最后一行显式执行，约多用 16 秒。没有模型时，部分原生测试会跳过，不能将跳过视为 Mac 模型验证通过。该 WAV 测试也不能替代物理麦克风和系统音频验收。

主要代码入口：`client/` 为界面与采集，`server/` 为存储、会话与实时服务，`server/providers/local-worker.cjs` 为本地语音推理，`server/providers/deepseek.ts` 为分析与检索，`desktop/` 为桌面启动和权限边界。不要把主线程性能与模型推理速度混为同一项指标。

## 重新生成 Mac 下载包

先确认模型已经下载，关闭正在运行的旧应用，再执行：

```bash
npm run package:mac
python3 scripts/archive-mac.py
```

第一步构建代码和 `.app`，输出到 `release/VC Meeting Assistant-darwin-arm64/`；第二步校验模型、arm64 二进制和关键资源，并保留 ZIP 中的符号链接和可执行权限。ZIP 命名为 `VC-Meeting-Assistant-{版本}-mac-arm64.zip`，版本来自 `package.json`，ZIP 与 `SHA256SUMS.txt` 默认输出到 `release/`。不要只压缩 `.app` 内部文件。

如需指定其他发布目录：

```bash
python3 scripts/archive-mac.py --output-dir ./release-assets
```

应将自定义发布目录留在 Git 工作区之外或加入自己的忽略配置，避免提交大型二进制。发布时上传 ZIP 和校验文件至 GitHub Release；源码提交不包含 `node_modules/`、模型、`.env`、用户数据与 `release/`。

本机签名安装脚本位于 `.app` 同目录的 `Install-on-Mac.command`。发布包没有 Developer ID 签名或公证；本机临时签名不能代替 Apple 公证或干净 Mac 上的实际安装验收。发布前应从生成的 ZIP 解压并走一次完整安装流程，不能只验证源码启动。

## Mac 实机验收清单

记录测试日期、Git commit 或 Release 标签、Mac 芯片/内存、macOS 版本、输入设备、耳机和会议软件版本。以下项目应在「真实会议」模式完成；演示模式不调用真实 ASR 或 DeepSeek。

- [ ] **干净安装与权限**：从 Release ZIP 解压，运行安装脚本并打开应用。记录 macOS 提示与处理步骤；点击开始采集后才请求权限。先拒绝麦克风，再重新授权，确认失败提示和恢复流程；线上模式另外核对系统音频/屏幕录制权限。
- [ ] **线下收音与首字**：选择麦克风，讲 2–3 分钟中英文与常用技术词。记录讲话开始到首条非空字幕的时间、暂定文字修订及自然停顿后的定稿；核对漏词、错词，保留已脱敏示例。模型暂不自动区分说话人。
- [ ] **线上双向收音**：在实际使用的会议软件中与另一人通话，佩戴耳机，分别确认自己与对方的语音都进入字幕；检查是否重音/重复，切换输入设备后确认行为。浏览器共享标签页结果不能代表桌面会议软件系统声音。
- [ ] **暂停与结束尾句**：说完整句后立刻暂停，确认最后几个字仍保存；继续后不重复旧句。结束会议时确认最后一句定稿后才能生成完整纪要，没有丢失或追加到下一场会议。
- [ ] **DeepSeek 真实调用**：填写有效密钥，上传非敏感 BP；确认摘要、追问、技术资料链接、纪要来自真实服务，问题能追溯到发言或材料。记录延迟和错误，检查无密钥/服务失败时本地字幕仍继续。不要在报告中附密钥。
- [ ] **持续 60 分钟**：保持真实收音，观察首尾延迟是否增加、CPU/内存、是否出现积压/断线提示；包括暂停/继续、网络断开后恢复、输入设备断开。当前未保证自动恢复，需如实记录是否需要重新开始采集。
- [ ] **保存与重启**：会后导出 Markdown、退出并重开，确认项目、材料、修改后的文字和纪要可读；分别核对未发布与已发布纪要、私人笔记的可见范围。
- [ ] **打包版本复验**：在生成并重新安装的 `.app` 中重复收音、尾句与重启检查，确认行为与源码模式一致。

合伙人异地同步不属于默认单机包的已交付部署：邀请链接的服务地址是本机，其他电脑无法直接访问。测试共享服务时另行配置 HTTPS/WSS，并记录两台设备与权限验证；这时音频发送到服务所在机器识别。部署概述见 [README](../README.md#共享服务部署)。

## 数据、日志与排错

桌面服务把 `DATA_DIR` 指向 Electron 的 `app.getPath('userData')`。Mac 上预期位于 `~/Library/Application Support/VC Meeting Assistant/`；源码模式若应用命名与打包版本不同，以当前 Electron 返回路径为准。目录含 `vc.sqlite`（运行时可能有 `-wal`/`-shm`）、`files/` 和配置 `.env`，以及启用原始音频保存时的 `audio/`。网页开发默认使用仓库下的 `data/`，因此与桌面账号/数据可能不同。

桌面优先加载 `DOTENV_CONFIG_PATH` 指定配置；未指定时，源码模式优先仓库 `.env`，打包模式优先 `.app` 旁的 `.env`，不存在才使用用户数据目录 `.env`。服务设置写入当前选用文件。模型默认在源码 `models/local-asr/` 或应用 `Contents/Resources/models/local-asr/`，也可用 `ASR_MODEL_DIR` 指定。

备份前退出应用并停止开发服务，再完整复制数据目录；不要只复制运行中的 SQLite 主文件。数据目录和配置含私人信息，不应作为 GitHub 问题附件。

从终端启动可直接看到服务输出：

```bash
npm run desktop
# 已安装的版本可在退出其他实例后这样启动：
"$HOME/Applications/VC Meeting Assistant.app/Contents/MacOS/VC Meeting Assistant"
```

服务运行后可检查：

```bash
curl -s http://127.0.0.1:4318/api/health
lsof -nP -iTCP:4318 -sTCP:LISTEN
```

`asr: true` 只说明模型文件与原生模块可找到，仍需开始采集/执行真实 WAV 测试验证原生加载和识别。`deepseek: true` 只说明存在密钥，不代表已调用成功。若端口占用，确认占用进程并关闭自己启动的旧实例，不要盲目终止其他应用。

模型缺失时重新运行 `npm run model:download`；运行库错误时先确认 Node 为 arm64、依赖安装成功，并记录错误的时间和复现步骤。系统音频问题要区分「没有权限」「没有输入」「有输入但没有字幕」。公开反馈使用 [Bug 模板](../.github/ISSUE_TEMPLATE/bug_report.md)，提交前删去真实会议内容、邮箱、API Key、Cookie 和本机私人路径。

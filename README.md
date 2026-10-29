# 知面 · 实时面试助手

这是一个 Windows Electron 桌面应用。桌面版通过 Windows 音频回环采集系统扬声器输出，所以腾讯会议、飞书会议或其他应用的播放声音都能进入识别。应用会自动启动本地 ASR 网关，并支持腾讯云 ASR、本地 FunASR、DeepSeek 流式回答、自定义提示词、手动问题调试，以及只显示问题和回答的置顶小窗模式。

## 启动

安装 Node.js 20+ 后，在项目根目录运行：

```powershell
npm install
npm start
```

点击「开始采集」后，桌面端会捕获当前 Windows 系统播放混音；不需要在浏览器里选择会议窗口，也不需要切换默认扬声器。结束时点击「结束」。采集只在用户主动开始后进行。

要生成 Windows 安装包：`npm run dist`。安装包会输出到 `dist/`，首次安装依赖和打包需要联网下载 Electron 运行时。

手动测试时，可在右侧输入框输入一道问题。先点左侧「模型设置」填写 DeepSeek API Key 和模型名称。DeepSeek 当前 Chat Completions 接口使用 `https://api.deepseek.com/chat/completions`，默认模型配置为 `deepseek-flash`（也可填写 `deepseek-v4-pro`）；答案使用 SSE 流式显示。

## 实时 ASR 接入

浏览器不能安全地直接持有腾讯云 SecretKey，因此音频会经本机 ASR 网关转发。桌面版会自动启动内置网关，默认地址为 `ws://127.0.0.1:8765/asr`。腾讯云凭据通过 `gateway/.env` 配置。原型与网关约定：

- 建连后客户端发送 JSON：`{"type":"start","provider":"tencent|funasr","format":"audio/webm;codecs=opus","sampleRate":16000}`。这是客户端到网关的私有协议，网关必须自行消费，不能原样转发给 ASR 服务。
- 桌面客户端继续用 `MediaRecorder` 将系统音频编码为连续 WebM/Opus 分片发送给网关；网关用随安装包提供的 FFmpeg 解码并重采样为 PCM。
- 网关将 PCM 按约 200ms 一块发送（16kHz 时 6400 字节），保持实时速率。
- 客户端结束时发送 `{"type":"stop"}`。网关需要把它翻译成腾讯云的 `{"type":"end"}` 文本消息，不能把 `{"type":"stop"}` 直接发给腾讯云。
- 网关返回 JSON：`{"type":"partial","text":"…"}` 更新临时识别文本；句子确定后返回 `{"type":"final","text":"…"}`，原型会自动把完整识别结果提交给 DeepSeek。`final` 应带有非空文本，避免覆盖当前问题。

腾讯云实时语音识别（WebSocket）的网关侧要求：

- 连接地址：`wss://asr.cloud.tencent.com/asr/v2/<appid>?secretid=…&timestamp=…&expired=…&nonce=…&engine_model_type=16k_zh_en&voice_id=<uuid>&voice_format=1&signature=…`。
- 网关先完成腾讯云握手并收到 `code=0` 的成功消息后，再开始发送音频；握手消息不要转发给浏览器。
- 签名：签名原文为 `asr.cloud.tencent.com/asr/v2/<appid>?` 加上去掉 `signature` 后按字典序拼接的参数；使用 SecretKey 做 HMAC-SHA1，再 Base64 编码并对结果 URL 编码。
- `voice_id` 每次连接重新生成；默认 `engine_model_type=16k_zh_en`；发送 PCM 时 `voice_format=1`（腾讯云的 PCM 编码值是 1，`0` 不是有效值）。
- 腾讯云返回 `result.slice_type`：0/1 为临时结果，2 为稳态结果，取 `result.voice_text_str` 映射为 `partial` / `final`；`final:1` 表示整条音频流结束且不带文本，不要把它当作 `final` 文本返回。

腾讯云与阿里云的鉴权签名必须在网关服务端完成；应由网关环境变量或密钥管理服务读取密钥。请勿将云厂商密钥放进浏览器代码。若页面通过 HTTPS 托管，网关地址需使用 `wss://`，否则浏览器会拦截混合内容。

### 本地 FunASR（CPU）

在本机安装 FunASR 依赖后，可在设置中选择「本地 FunASR（CPU）」。服务使用 `paraformer-zh-streaming` 并固定在 CPU 上运行，首次运行会下载并缓存语音模型。依赖安装方式见 `gateway/funasr-requirements.txt`。

### 启动内置本地网关

腾讯云模式需要三个凭据：`AppID`、`SecretID`、`SecretKey`。本地 FunASR 模式不需要这些凭据。它们不是同一个值：

- 登录腾讯云控制台，进入「访问管理 CAM → API 密钥管理」，可看到 `AppID`、`SecretID` 和 `SecretKey`；如果密钥被禁用或删除，会返回 `4002 密钥不存在`。
- 在「语音识别」控制台确认已开通实时语音识别服务。
- 不要把云密钥写进 `index.html`，只放在 `gateway/.env`。

开发时如需手动配置网关，Windows PowerShell 示例：

```powershell
cd gateway
npm install
Copy-Item .env.example .env
# 编辑 gateway/.env，填入 TENCENT_APPID / TENCENT_SECRET_ID / TENCENT_SECRET_KEY
```

启动桌面应用时，Electron 会在后台自动启动内置网关，并在退出时关闭网关。无需再单独打开终端运行 `npm start`。开发版默认读取 `gateway/.env`；应用默认连接地址为：

```text
ws://127.0.0.1:8765/asr
```

网关依赖：

- Node.js 18+（当前机器已满足）。
- `ws` 由 `npm install` 安装。
- FFmpeg 需单独安装并加入系统 PATH。

可选的连通性检查：

```powershell
# 另开一个终端，在 gateway 目录执行
npm run smoke
```

该检查只验证 WebSocket 连接和腾讯云鉴权；真实识别还需要在页面里共享系统音频。若返回 `4002`，检查 `.env` 中的 SecretID/SecretKey 是否复制完整、是否含空格，以及密钥是否被禁用。若返回 `4001` 或参数错误，检查 AppID 和 `TENCENT_ENGINE_MODEL`。

## Windows 音频实现

`desktop/main.js` 使用 Electron `setDisplayMediaRequestHandler` 选择系统屏幕源并授予 `audio: 'loopback'`。Electron 在 Windows 上将其映射到系统输出回环；渲染进程只接收音轨，并由 `MediaRecorder` 编码为 WebM/Opus 后发送给本机 ASR 网关。界面不显示或处理捕获的屏幕画面。此模式捕获 Windows 默认系统混音，而不是只捕获某个特定会议进程；若会议声音使用耳机播放，仍会从该耳机的系统输出混音中采集。

## 原型边界

桌面版和 Windows 系统回环采集已经接入；实时转写可选腾讯云，或在本地安装依赖后运行 CPU FunASR。阿里云 Paraformer 网关尚未实现。DeepSeek API Key 保存在当前应用的浏览器配置中，请勿在共用 Windows 账户上保存个人密钥。

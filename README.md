# 知面 · 实时面试助手

这是一个 Windows Electron 桌面应用。桌面版通过 Electron 的 Windows 音频回环设备采集系统扬声器输出（WASAPI Loopback），所以腾讯会议、飞书会议或其他应用只要正在从 Windows 播放设备播放声音，就能进入音频流。应用窗口默认开启 Windows 屏幕捕获保护，并支持在界面切换；另外支持腾讯云 ASR、本地网关、DeepSeek 流式回答、自定义提示词、手动问题调试，以及只显示问题和回答的置顶小窗模式。

## 启动

安装 Node.js 20+ 后，在项目根目录运行：

```powershell
npm install
npm start
```

点击「开始采集」后，桌面端会捕获当前 Windows 系统播放混音；不需要在浏览器里选择会议窗口，也不需要切换默认扬声器。结束时点击「结束」。采集只在用户主动开始后进行。

要生成 Windows 安装包：

```powershell
npm run dist
```

安装包会输出到 `dist/`。首次安装依赖和打包需要联网下载 Electron 运行时。

手动测试时，可在右侧输入框输入一道问题。先点左侧「模型设置」填写 DeepSeek API Key 和模型名称。DeepSeek 当前 Chat Completions 接口使用 `https://api.deepseek.com/chat/completions`，默认模型配置为 `deepseek-flash`（也可填写 `deepseek-v4-pro`）；答案使用 SSE 流式显示。

## 实时 ASR 接入

浏览器不能安全地持有腾讯云 SecretKey 或阿里云长期凭据，因此音频需要经本机 ASR 网关转发。腾讯云不会提供「本地网关地址」；这个地址是你自己启动网关后得到的，本仓库已在 `gateway/` 里内置一个可运行的腾讯云本地网关。点「配置 ASR 凭据与连接」填入 `ws://127.0.0.1:8765/asr`。原型与网关约定：

- 建连后客户端发送 JSON：`{"type":"start","provider":"tencent|aliyun","format":"audio/webm;codecs=opus","sampleRate":16000}`。这是客户端到网关的私有协议，网关必须自行消费，不能原样转发给腾讯云。
- 客户端每 200ms 发送一个仅含音频轨的 `MediaRecorder` Blob（WebM/Opus）。这些 Blob 是同一路 WebM 流的分片，不是独立文件；网关必须为每个连接维持一个连续的流式解码器。
- 网关将音频解码并重采样为厂商要求的 16kHz（或 8kHz）、16bit、单声道 PCM，再按约 200ms 一块发送（16kHz 时 6400 字节），保持 1:1 实时速率。
- 客户端结束时发送 `{"type":"stop"}`。网关需要把它翻译成腾讯云的 `{"type":"end"}` 文本消息，不能把 `{"type":"stop"}` 直接发给腾讯云。
- 网关返回 JSON：`{"type":"partial","text":"…"}` 更新临时识别文本；句子确定后返回 `{"type":"final","text":"…"}`，原型会自动把完整识别结果提交给 DeepSeek。`final` 应带有非空文本，避免覆盖当前问题。

腾讯云实时语音识别（WebSocket）的网关侧要求：

- 连接地址：`wss://asr.cloud.tencent.com/asr/v2/<appid>?secretid=…&timestamp=…&expired=…&nonce=…&engine_model_type=16k_zh&voice_id=<uuid>&voice_format=1&signature=…`。
- 网关先完成腾讯云握手并收到 `code=0` 的成功消息后，再开始发送音频；握手消息不要转发给浏览器。
- 签名：签名原文为 `asr.cloud.tencent.com/asr/v2/<appid>?` 加上去掉 `signature` 后按字典序拼接的参数；使用 SecretKey 做 HMAC-SHA1，再 Base64 编码并对结果 URL 编码。
- `voice_id` 每次连接重新生成；`engine_model_type` 例如 `16k_zh`；发送 PCM 时 `voice_format=1`（腾讯云的 PCM 编码值是 1，`0` 不是有效值）。
- 腾讯云返回 `result.slice_type`：0/1 为临时结果，2 为稳态结果，取 `result.voice_text_str` 映射为 `partial` / `final`；`final:1` 表示整条音频流结束且不带文本，不要把它当作 `final` 文本返回。

腾讯云与阿里云的鉴权签名必须在网关服务端完成；应由网关环境变量或密钥管理服务读取密钥。请勿将云厂商密钥放进浏览器代码。若页面通过 HTTPS 托管，网关地址需使用 `wss://`，否则浏览器会拦截混合内容。

### 启动内置本地网关

网关需要三个腾讯云凭据：`AppID`、`SecretID`、`SecretKey`。它们不是同一个值：

- 登录腾讯云控制台，进入「访问管理 CAM → API 密钥管理」，可看到 `AppID`、`SecretID` 和 `SecretKey`；如果密钥被禁用或删除，会返回 `4002 密钥不存在`。
- 在「语音识别」控制台确认已开通实时语音识别服务。
- 不要把密钥写进 `index.html`，只放在 `gateway/.env`。

Windows PowerShell 下启动：

```powershell
cd gateway
npm install
Copy-Item .env.example .env
# 编辑 gateway/.env，填入 TENCENT_APPID / TENCENT_SECRET_ID / TENCENT_SECRET_KEY
npm start
```

看到 `listening on ws://127.0.0.1:8765/asr` 后，在页面的 ASR 配置里填：

```text
ws://127.0.0.1:8765/asr
```

网关依赖：

- Node.js 18+（当前机器已满足）。
- `ffmpeg` 已加入 PATH（用于把浏览器的 WebM/Opus 分片连续解码为 16kHz、16bit、单声道 PCM）。
- `ws` 由 `npm install` 安装。

可选的连通性检查：

```powershell
# 另开一个终端，在 gateway 目录执行
npm run smoke
```

该检查只验证 WebSocket 连接和腾讯云鉴权；真实识别还需要在页面里共享系统音频。若返回 `4002`，检查 `.env` 中的 SecretID/SecretKey 是否复制完整、是否含空格，以及密钥是否被禁用。若返回 `4001` 或参数错误，检查 AppID 和 `TENCENT_ENGINE_MODEL`。

## Windows 音频实现

`desktop/main.js` 使用 Electron `setDisplayMediaRequestHandler` 选择系统屏幕源并授予 `audio: 'loopback'`。Electron 在 Windows 上将其映射到系统输出回环；渲染进程只接收音轨，并由 `MediaRecorder` 编码为 WebM/Opus 后发送给本机 ASR 网关。界面不显示或处理捕获的屏幕画面。此模式捕获 Windows 默认系统混音，而不是只捕获某个特定会议进程；若会议声音使用耳机播放，仍会从该耳机的系统输出混音中采集。

## 原型边界

桌面版和 Windows 系统回环采集已经接入；实时语音转写需要单独运行 `gateway/` 中的腾讯云网关。当前不包含阿里云 Paraformer 网关实现。长期使用建议把 DeepSeek 调用也代理到本机服务，以免 API Key 保存在浏览器本地存储。

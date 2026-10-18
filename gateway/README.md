# 知面本地 ASR 网关（腾讯云）

这个网关把页面的私有 WebSocket 协议翻译成腾讯云实时语音识别协议：

```text
index.html
  │  ws://127.0.0.1:8765/asr
  │  {"type":"start"} + WebM/Opus 分片 + {"type":"stop"}
  ▼
本地网关（Node.js + ffmpeg）
  │  wss://asr.cloud.tencent.com/asr/v2/<appid>?signature=...
  │  16kHz / 16bit / 单声道 PCM，200ms 一块
  ▼
腾讯云实时 ASR
```

## 1. 准备凭据

腾讯云不会提供「本地网关地址」。地址是你启动这个网关后得到的，默认是：

```text
ws://127.0.0.1:8765/asr
```

你需要准备三个值，缺一不可：

| 变量 | 从哪里获取 |
| --- | --- |
| `TENCENT_APPID` | 腾讯云控制台「访问管理 CAM → API 密钥管理」页面显示的 AppID |
| `TENCENT_SECRET_ID` | 同一页面的 SecretId |
| `TENCENT_SECRET_KEY` | 同一页面的 SecretKey |

同时在「语音识别」控制台确认已开通实时语音识别服务。`4002 密钥不存在` 通常表示 SecretId/SecretKey 复制错误、密钥被禁用或删除；不是网关地址的问题。

## 2. 安装并启动

本机需要 Node.js 18+ 和 ffmpeg（都要在 PATH 中）。

```powershell
cd gateway
npm install
Copy-Item .env.example .env
```

编辑 `gateway/.env`：

```dotenv
TENCENT_APPID=1250000000
TENCENT_SECRET_ID=AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TENCENT_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TENCENT_ENGINE_MODEL=16k_zh
ASR_GATEWAY_HOST=127.0.0.1
ASR_GATEWAY_PORT=8765
```

启动：

```powershell
npm start
```

看到下面这行即成功：

```text
[gateway] listening on ws://127.0.0.1:8765/asr
```

然后在 `index.html` 的「配置 ASR 凭据与连接」中填入：

```text
ws://127.0.0.1:8765/asr
```

## 3. 自检

另开一个终端，在 `gateway` 目录执行：

```powershell
npm run smoke
```

它会连接网关、发送 `start`，然后发送 `stop`。如果凭据正确，会看到腾讯云握手成功以及结束流程；如果返回 `4002`，按上面的凭据检查。自检不发送真实音频，所以不能替代页面里的系统音频测试。

也可以检查健康接口：

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health
```

## 4. 页面协议

客户端 → 网关：

- `{"type":"start","provider":"tencent","format":"audio/webm;codecs=opus","sampleRate":16000}`
- 二进制 WebM/Opus 分片（约每 200ms 一个）
- `{"type":"stop"}`

网关 → 客户端：

- `{"type":"ready"}`：腾讯云握手成功
- `{"type":"partial","text":"…"}`：临时结果
- `{"type":"final","text":"…"}`：句子稳态结果
- `{"type":"error","message":"…"}`：错误信息
- `{"type":"done"}`：腾讯云返回 `final:1`，音频流结束

## 5. 实现要点

- 每个浏览器连接只启动一个 ffmpeg 进程，把连续的 WebM/Opus 分片解码为 16kHz、16bit、单声道 PCM。分片不能各自当成独立文件解码。
- PCM 按 6400 字节（200ms）一块、以约 1:1 实时速率发送给腾讯云；停止时先结束 ffmpeg 输入、冲刷剩余 PCM，再发送 `{"type":"end"}`。
- 腾讯云签名原文为 `asr.cloud.tencent.com/asr/v2/<appid>?` 加按字典序拼接的参数，使用 SecretKey 做 HMAC-SHA1，再 Base64 编码并对结果 URL 编码。
- `voice_id` 每个连接重新生成；腾讯云实时 ASR 的 `voice_format=1` 表示 PCM（`0` 不是有效值，默认值是 `4`）；默认 `engine_model_type=16k_zh`。
- 腾讯云 `result.slice_type` 为 0/1 时映射为 `partial`，为 2 时映射为 `final`；`final:1` 是流结束标志，不带文本，不能当成 `final` 文本。
- 网关只监听 `127.0.0.1`，避免把腾讯云额度暴露给局域网。若页面通过 HTTPS 托管，浏览器会拦截 `ws://`，需要把网关放到 `wss://` 反向代理后面。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| `4002 密钥不存在` | SecretId/SecretKey 不正确、被禁用或前后有空格 |
| `4001` / 参数错误 | 检查 AppID、`TENCENT_ENGINE_MODEL`，以及系统时间是否准确 |
| 页面提示 ASR 网关连接失败 | 确认网关已启动、端口一致、地址以 `ws://` 开头 |
| 没有识别结果 | 确认共享的是「系统音频/标签页音频」且勾选了共享音频；查看网关日志是否有 ffmpeg 报错 |
| `ffmpeg 启动失败` | 执行 `ffmpeg -version`，把 ffmpeg 加入 PATH 后重启终端 |
| 页面是 HTTPS 打不开网关 | 混合内容限制，需使用 `wss://` 或改用本地 HTTP 打开页面 |

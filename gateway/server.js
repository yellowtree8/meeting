'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

let WebSocketServer;
let WebSocket;
try {
  ({ WebSocketServer, WebSocket } = require('ws'));
} catch {
  console.error('[config] 未安装依赖，请先在 gateway 目录运行: npm install');
  process.exit(1);
}

loadEnvFile();

const HOST = process.env.ASR_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(process.env.ASR_GATEWAY_PORT || 8765);
const APPID = process.env.TENCENT_APPID || '';
const SECRET_ID = process.env.TENCENT_SECRET_ID || '';
const SECRET_KEY = process.env.TENCENT_SECRET_KEY || '';
const ENGINE = process.env.TENCENT_ENGINE_MODEL || '16k_zh';
const SAMPLE_RATE = 16000;
const FRAME_BYTES = 6400; // 200ms * 16000Hz * 2 bytes * 1 channel
const FRAME_MS = 200;
const MAX_QUEUE_BYTES = SAMPLE_RATE * 2 * 10; // 10 seconds of PCM
const TENCENT_ORIGIN = 'asr.cloud.tencent.com/asr/v2';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      provider: 'tencent',
      engine: ENGINE,
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/asr' });

wss.on('connection', (client) => {
  new AsrSession(client).attach();
});

server.on('error', (err) => {
  console.error('[gateway] listen error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`[gateway] listening on ws://${HOST}:${PORT}/asr`);
  log(`[gateway] tencent engine=${ENGINE}, appid=${APPID}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  log('[gateway] shutting down');
  if (funasrProcess && !funasrProcess.killed) funasrProcess.kill();
  wss.clients.forEach((client) => {
    try { client.close(); } catch {}
  });
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1500).unref();
}

class AsrSession {
  constructor(client) {
    this.client = client;
    this.tencent = null;
    this.funasr = null;
    this.provider = 'tencent';
    this.ffmpeg = null;
    this.started = false;
    this.stopping = false;
    this.cleaned = false;
    this.tencentReady = false;
    this.ended = false;
    this.sendTimer = null;
    this.finalTimer = null;
    this.ffmpegClosed = false;
    this.ffmpegCloseResolve = null;
    this.pcmQueue = Buffer.alloc(0);
    this.hotwordList = '';
  }

  attach() {
    log('[client] connected');
    this.client.on('message', (data, isBinary) => {
      if (isBinary) {
        this.onAudio(data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'start') this.start(msg);
      else if (msg.type === 'stop') this.stop();
    });
    this.client.on('close', () => {
      log('[client] disconnected');
      this.cleanup();
    });
    this.client.on('error', (err) => {
      log('[client] error', err.message);
      this.cleanup();
    });
  }

  start(msg) {
    if (this.started) return;
    this.started = true;
    this.provider = msg.provider || 'tencent';
    if (!['tencent', 'funasr'].includes(this.provider)) {
      this.fail('当前网关支持腾讯云 ASR 和本地 FunASR；阿里云模式尚未接入');
      return;
    }
    this.hotwordList = formatHotwordList(msg.hotwords);
    log('[session] start', {
      format: msg.format || 'unknown',
      sampleRate: msg.sampleRate || 'unknown',
      hotwordCount: this.hotwordList ? this.hotwordList.split(',').length : 0,
    });
    this.startFfmpeg();
    if (this.provider === 'funasr') this.connectFunASR();
    else this.connectTencent();
  }

  onAudio(chunk) {
    if (!this.started || this.stopping) return;
    if (this.ffmpeg && this.ffmpeg.stdin.writable) {
      this.ffmpeg.stdin.write(chunk);
    }
  }

  startFfmpeg() {
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpeg.stdout.on('data', (chunk) => {
      if (this.provider === 'funasr') {
        if (this.funasr && this.funasr.readyState === WebSocket.OPEN) this.funasr.send(chunk);
        else this.pcmQueue = Buffer.concat([this.pcmQueue, chunk]);
        return;
      }
      this.pcmQueue = Buffer.concat([this.pcmQueue, chunk]);
      if (this.pcmQueue.length > MAX_QUEUE_BYTES) {
        let drop = this.pcmQueue.length - MAX_QUEUE_BYTES;
        if (drop % 2) drop += 1;
        this.pcmQueue = this.pcmQueue.subarray(drop);
      }
    });
    this.ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log('[ffmpeg]', text);
    });
    this.ffmpeg.on('error', (err) => {
      this.fail('ffmpeg 启动失败，请确认 ffmpeg 已加入 PATH：' + err.message);
    });
    this.ffmpeg.on('close', (code) => {
      this.ffmpegClosed = true;
      if (code && code !== 0) {
        log('[ffmpeg] exited with code', code);
        if (!this.stopping) this.fail('ffmpeg 解码失败，请确认共享的是音频流');
      }
      if (this.ffmpegCloseResolve) {
        this.ffmpegCloseResolve();
        this.ffmpegCloseResolve = null;
      }
    });
    this.ffmpeg.stdin.on('error', () => {});
  }

  connectTencent() {
    try { assertConfig(); } catch (error) { this.fail(error.message); return; }
    const url = buildTencentUrl(this.hotwordList);
    log('[tencent] connecting');
    this.tencent = new WebSocket(url);

    // Tencent normally reports auth and account errors as a JSON WebSocket
    // frame (for example 4002). If the HTTP upgrade itself is rejected, keep
    // the status and a short, redacted response body for diagnosis as well.
    this.tencent.on('unexpected-response', (_request, response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (size >= 2048) return;
        const part = Buffer.from(chunk).subarray(0, 2048 - size);
        chunks.push(part);
        size += part.length;
      });
      response.on('end', () => {
        const body = redactTencentSecrets(Buffer.concat(chunks).toString('utf8'));
        const detail = body ? `: ${body.slice(0, 500)}` : '';
        this.fail(`腾讯云 ASR HTTP ${response.statusCode || 'unknown'}（WebSocket 握手被拒绝）${detail}`);
      });
      response.on('error', (err) => {
        this.fail(`腾讯云 ASR HTTP 握手响应读取失败：${err.message}`);
      });
    });

    this.tencent.on('open', () => {
      log('[tencent] socket open, waiting for handshake');
    });
    this.tencent.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onTencentMessage(msg);
    });
    this.tencent.on('error', (err) => {
      if (!this.cleaned) this.fail('腾讯云 ASR 连接失败：' + err.message);
    });
    this.tencent.on('close', (code, reason) => {
      log('[tencent] closed', code, reason ? reason.toString() : '');
      if (!this.cleaned && !this.ended && !this.stopping) {
        this.fail('腾讯云 ASR 连接已断开');
      }
    });
  }

  connectFunASR() {
    ensureFunASRService();
    const endpoint = process.env.FUNASR_WS_URL || 'ws://127.0.0.1:8766/asr';
    log('[funasr] connecting to local CPU service');
    let attempts = 0;
    const connect = () => {
      if (this.cleaned) return;
      attempts += 1;
      const socket = new WebSocket(endpoint);
      this.funasr = socket;
      let retrying = false;
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'start' }));
        if (this.pcmQueue.length) {
          socket.send(this.pcmQueue);
          this.pcmQueue = Buffer.alloc(0);
        }
        if (this.funasrStopRequested) socket.send(JSON.stringify({ type: 'stop' }));
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'ready') {
          this.send({ type: 'ready' });
          log('[funasr] model ready on CPU');
        } else if (['partial', 'final', 'done', 'error'].includes(msg.type)) {
          this.send(msg);
          if (msg.type === 'done') {
            this.ended = true;
            if (this.finalTimer) clearTimeout(this.finalTimer);
            setTimeout(() => { this.cleanup(); try { this.client.close(); } catch {} }, 100);
          } else if (msg.type === 'error') this.cleanup();
        }
      });
      socket.on('error', (err) => {
        if (this.cleaned) return;
        if (attempts < 20) {
          retrying = true;
          log('[funasr] service is starting; retrying');
          this.funasrConnectTimer = setTimeout(connect, 500);
        } else {
          this.fail('本地 FunASR 服务连接失败：' + err.message + '。请安装 Python/FunASR 环境后重启应用。');
        }
      });
      socket.on('close', () => {
        if (!this.cleaned && !this.ended && !retrying) this.fail('本地 FunASR 服务已断开');
      });
    };
    connect();
  }

  onTencentMessage(msg) {
    if (msg.code !== undefined && Number(msg.code) !== 0) {
      this.fail(formatTencentError(msg.code, msg.message));
      return;
    }

    if (!this.tencentReady) {
      this.tencentReady = true;
      log('[tencent] handshake ok');
      this.send({ type: 'ready' });
      this.startSendTimer();
    }

    const text = msg.result && msg.result.voice_text_str
      ? String(msg.result.voice_text_str).trim()
      : '';
    if (text) {
      if (Number(msg.result.slice_type) === 2) {
        this.send({ type: 'final', text });
      } else {
        this.send({ type: 'partial', text });
      }
    }

    if (Number(msg.final) === 1) {
      this.ended = true;
      log('[tencent] stream final');
      if (this.finalTimer) {
        clearTimeout(this.finalTimer);
        this.finalTimer = null;
      }
      this.send({ type: 'done' });
      setTimeout(() => {
        this.cleanup();
        try { this.client.close(); } catch {}
      }, 100);
    }
  }

  startSendTimer() {
    if (this.sendTimer) return;
    this.sendTimer = setInterval(() => {
      if (!this.tencentReady || !this.tencent || this.tencent.readyState !== WebSocket.OPEN) return;
      if (this.pcmQueue.length < FRAME_BYTES) return;
      const frame = this.pcmQueue.subarray(0, FRAME_BYTES);
      this.pcmQueue = this.pcmQueue.subarray(FRAME_BYTES);
      this.tencent.send(frame);
    }, FRAME_MS);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    log('[session] stop');
    this.stopFfmpeg().then(() => this.flushPcm()).then(() => {
      if (this.provider === 'funasr') {
        this.funasrStopRequested = true;
        if (this.funasr && this.funasr.readyState === WebSocket.OPEN) {
          this.funasr.send(JSON.stringify({ type: 'stop' }));
        }
        this.finalTimer = setTimeout(() => {
          this.cleanup();
          try { this.client.close(); } catch {}
        }, 300000);
      } else if (this.tencentReady && this.tencent && this.tencent.readyState === WebSocket.OPEN) {
        this.tencent.send(JSON.stringify({ type: 'end' }));
        log('[tencent] sent end, waiting for final');
        this.finalTimer = setTimeout(() => {
          log('[tencent] final wait timeout');
          this.cleanup();
          try { this.client.close(); } catch {}
        }, 5000);
      } else {
        this.cleanup();
        try { this.client.close(); } catch {}
      }
    }).catch((err) => {
      this.fail('结束识别失败：' + err.message);
    });
  }

  stopFfmpeg() {
    if (!this.ffmpeg || this.ffmpegClosed) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.ffmpegCloseResolve = null;
        resolve();
      };
      this.ffmpegCloseResolve = finish;
      try {
        this.ffmpeg.stdin.end();
      } catch {
        finish();
      }
      setTimeout(() => {
        if (!this.ffmpegClosed) {
          try { this.ffmpeg.kill('SIGKILL'); } catch {}
        }
        finish();
      }, 3000);
    });
  }

  async flushPcm() {
    if (this.provider === 'funasr') {
      if (this.pcmQueue.length && this.funasr?.readyState === WebSocket.OPEN) {
        this.funasr.send(this.pcmQueue);
        this.pcmQueue = Buffer.alloc(0);
      }
      return;
    }
    if (!this.tencentReady || !this.tencent || this.tencent.readyState !== WebSocket.OPEN) return;
    while (this.pcmQueue.length > 0) {
      if (this.cleaned || !this.tencent || this.tencent.readyState !== WebSocket.OPEN) return;
      const size = Math.min(FRAME_BYTES, this.pcmQueue.length);
      const frame = this.pcmQueue.subarray(0, size);
      this.pcmQueue = this.pcmQueue.subarray(size);
      this.tencent.send(frame);
      await delay(FRAME_MS);
    }
  }

  send(obj) {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(obj));
    }
  }

  fail(message) {
    if (this.cleaned) return;
    log('[error]', message);
    this.send({ type: 'error', message });
    this.cleanup();
    try { this.client.close(); } catch {}
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    if (this.funasrConnectTimer) clearTimeout(this.funasrConnectTimer);
    this.sendTimer = null;
    this.finalTimer = null;
    if (this.tencent) {
      try { this.tencent.removeAllListeners(); this.tencent.terminate(); } catch {}
      this.tencent = null;
    }
    if (this.funasr) {
      try { this.funasr.removeAllListeners(); this.funasr.terminate(); } catch {}
      this.funasr = null;
    }
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGKILL'); } catch {}
      this.ffmpeg = null;
    }
  }
}

function formatHotwordList(input) {
  const terms = String(input || '').split(/[\r\n,，;；]+/).map((value) => value.trim()).filter(Boolean).slice(0, 128);
  return terms.map((term) => {
    const match = term.match(/^(.*?)(?:\|(\d+))?$/);
    const word = match[1].trim();
    const weight = match[2] ? Number(match[2]) : 8;
    if (!word) return '';
    const safeWeight = weight === 100 ? 100 : Math.max(1, Math.min(11, weight || 8));
    return `${word}|${safeWeight}`;
  }).filter(Boolean).join(',');
}

function buildTencentUrl(hotwordList = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    engine_model_type: ENGINE,
    expired: timestamp + 86400,
    needvad: 1,
    nonce: crypto.randomInt(1, 1_000_000_000),
    secretid: SECRET_ID,
    timestamp,
    voice_format: 1, // 1 = PCM (16bit, mono)
    voice_id: crypto.randomUUID(),
  };
  if (hotwordList) params.hotword_list = hotwordList;
  const keys = Object.keys(params).sort();
  const origin = TENCENT_ORIGIN + '/' + APPID + '?' +
    keys.map((key) => `${key}=${params[key]}`).join('&');
  const signature = crypto
    .createHmac('sha1', SECRET_KEY)
    .update(origin)
    .digest('base64');
  const query = new URLSearchParams();
  for (const key of keys) query.set(key, String(params[key]));
  query.set('signature', signature);
  return `wss://${TENCENT_ORIGIN}/${APPID}?${query.toString()}`;
}

function formatTencentError(code, message) {
  const known = {
    4001: '请求参数不合法，请核对 AppID、引擎和签名参数。',
    4002: '鉴权失败。确认 AppID、SecretID、SecretKey 属于同一腾讯云账号，SecretID/SecretKey 完整且仍有效，并确认系统时间准确。',
    4003: '该 AppID 尚未开通语音识别服务，请在腾讯云控制台开通。',
    4004: '语音识别资源包已耗尽，请购买资源包或开通后付费。',
    4005: '腾讯云账号欠费，服务已停止，请先处理账户欠费。',
    4006: '当前 ASR 并发数超限。',
    6001: '当前请求被识别为境外调用；请检查代理或网络出口，并使用对应站点开通服务。',
  }[Number(code)];
  return `腾讯云 ASR 错误 ${code}: ${message || 'unknown'}${known ? `。${known}` : ''}`;
}

function redactTencentSecrets(text) {
  return String(text || '')
    .replaceAll(SECRET_ID, '[redacted-secret-id]')
    .replaceAll(SECRET_KEY, '[redacted-secret-key]')
    .replace(/([?&]signature=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function assertConfig() {
  const missing = [];
  if (!APPID) missing.push('TENCENT_APPID');
  if (!SECRET_ID) missing.push('TENCENT_SECRET_ID');
  if (!SECRET_KEY) missing.push('TENCENT_SECRET_KEY');
  if (missing.length) {
    throw new Error('腾讯云 ASR 缺少配置：' + missing.join(', ') + '。填写 gateway/.env 后重启，或选择本地 FunASR。');
  }
}

let funasrProcess = null;
function ensureFunASRService() {
  if (funasrProcess && funasrProcess.exitCode === null) return;
  let script = path.join(__dirname, 'funasr_server.py');
  if (process.resourcesPath && __dirname.includes('app.asar')) {
    script = path.join(process.resourcesPath, 'app.asar.unpacked', 'gateway', 'funasr_server.py');
  }
  const python = process.env.FUNASR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  funasrProcess = spawn(python, [script], { stdio: 'ignore', windowsHide: true });
  funasrProcess.on('error', (err) => log('[funasr] could not start Python service:', err.message));
  funasrProcess.on('exit', (code) => {
    log('[funasr] service exited', code);
    funasrProcess = null;
  });
}

function loadEnvFile() {
  const envPath = process.env.ASR_GATEWAY_ENV_FILE || path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}


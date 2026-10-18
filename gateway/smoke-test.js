'use strict';

const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8765/asr';
const ws = new WebSocket(url);
let done = false;

function finish(code) {
  if (done) return;
  done = true;
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 100);
}

ws.on('open', () => {
  console.log('[smoke] connected:', url);
  ws.send(JSON.stringify({
    type: 'start',
    provider: 'tencent',
    format: 'audio/webm;codecs=opus',
    sampleRate: 16000,
  }));
  setTimeout(() => {
    console.log('[smoke] sending stop');
    ws.send(JSON.stringify({ type: 'stop' }));
  }, 1000);
});

ws.on('message', (data) => {
  console.log('[smoke]', data.toString());
  const msg = JSON.parse(data.toString());
  if (msg.type === 'error') finish(1);
  if (msg.type === 'done') finish(0);
});

ws.on('error', (err) => {
  console.error('[smoke] websocket error:', err.message);
  finish(1);
});

ws.on('close', (code) => {
  console.log('[smoke] closed:', code);
  finish(0);
});

setTimeout(() => {
  console.log('[smoke] timeout');
  finish(1);
}, 8000);

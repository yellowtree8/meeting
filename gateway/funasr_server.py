"""Local CPU FunASR streaming service for the desktop ASR gateway."""

import asyncio
import json
import logging
import os

if os.environ.get("FUNASR_CACHE_DIR"):
    os.environ.setdefault("MODELSCOPE_CACHE", os.environ["FUNASR_CACHE_DIR"])

import numpy as np
import websockets
from funasr import AutoModel

HOST = os.environ.get("FUNASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUNASR_PORT", "8766"))
MODEL_NAME = os.environ.get("FUNASR_MODEL", "paraformer-zh-streaming")
if MODEL_NAME == "paraformer-zh-streaming" and os.environ.get("FUNASR_CACHE_DIR"):
    cached_model = os.path.join(
        os.environ["FUNASR_CACHE_DIR"],
        "models",
        "iic--speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online",
        "snapshots",
        "master",
    )
    if os.path.isfile(os.path.join(cached_model, "config.yaml")):
        MODEL_NAME = cached_model
CHUNK_SIZE = [0, 10, 5]  # 600 ms input blocks, with 300 ms lookahead
SAMPLES_PER_CHUNK = CHUNK_SIZE[1] * 960
END_SILENCE_BLOCKS = 2
MODEL = None
MODEL_LOCK = asyncio.Lock()
INFER_LOCK = asyncio.Lock()


async def get_model():
    global MODEL
    if MODEL is None:
        async with MODEL_LOCK:
            if MODEL is None:
                logging.info("Loading %s on CPU; first run downloads model files", MODEL_NAME)
                MODEL = await asyncio.to_thread(
                    AutoModel,
                    model=MODEL_NAME,
                    device="cpu",
                    disable_update=True,
                    disable_pbar=True,
                )
                logging.info("FunASR model loaded")
    return MODEL


async def recognize(websocket):
    pcm = bytearray()
    pending_block = None
    silence_blocks = 0
    cache = {}
    transcript = ""
    model = None
    started = False
    try:
        async for message in websocket:
            if isinstance(message, str):
                try:
                    command = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if command.get("type") == "start" and not started:
                    started = True
                    model = await get_model()
                    await websocket.send(json.dumps({"type": "ready"}, ensure_ascii=False))
                elif command.get("type") == "stop" and started:
                    tail = (pending_block or b"") + bytes(pcm)
                    if tail:
                        text = await infer(model, tail, cache, is_final=True)
                        transcript += text
                        pcm.clear()
                        if transcript.strip():
                            await websocket.send(json.dumps({"type": "final", "text": transcript.strip()}, ensure_ascii=False))
                    await websocket.send(json.dumps({"type": "done"}))
                    return
                continue

            if not started or model is None:
                continue
            pcm.extend(message)
            bytes_per_chunk = SAMPLES_PER_CHUNK * 2
            while len(pcm) >= bytes_per_chunk:
                block = bytes(pcm[:bytes_per_chunk])
                del pcm[:bytes_per_chunk]
                if is_speech(block):
                    silence_blocks = 0
                    if pending_block is not None:
                        text = await infer(model, pending_block, cache, is_final=False)
                        if text:
                            transcript += text
                            await websocket.send(json.dumps({"type": "partial", "text": transcript}, ensure_ascii=False))
                    pending_block = block
                elif pending_block is not None:
                    silence_blocks += 1
                    if silence_blocks >= END_SILENCE_BLOCKS:
                        text = await infer(model, pending_block, cache, is_final=True)
                        transcript += text
                        if transcript.strip():
                            await websocket.send(json.dumps({"type": "final", "text": transcript.strip()}, ensure_ascii=False))
                        pending_block = None
                        silence_blocks = 0
                        transcript = ""
                        cache = {}
    except websockets.ConnectionClosed:
        pass
    except Exception as error:
        logging.exception("FunASR session failed")
        try:
            await websocket.send(json.dumps({"type": "error", "message": f"本地 FunASR 识别失败：{error}"}, ensure_ascii=False))
        except websockets.ConnectionClosed:
            pass


async def infer(model, pcm_bytes, cache, is_final):
    speech = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    async with INFER_LOCK:
        result = await asyncio.to_thread(
            model.generate,
            input=speech,
            cache=cache,
            is_final=is_final,
            chunk_size=CHUNK_SIZE,
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
            batch_size=1,
        )
    if not result:
        return ""
    return str(result[0].get("text", "")).strip()


def is_speech(pcm_bytes):
    samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    return bool(samples.size and np.sqrt(np.mean(samples * samples)) >= 0.008)


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    async with websockets.serve(recognize, HOST, PORT, max_size=None, ping_interval=20):
        logging.info("FunASR CPU service listening on ws://%s:%d/asr", HOST, PORT)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())

import asyncio
import aiohttp
import redis.asyncio as redis
import json
import tempfile
import os
from concurrent.futures import ThreadPoolExecutor
from faster_whisper import WhisperModel
from datetime import datetime

CAM_AUDIO_URL = os.getenv("CAM_AUDIO_URL", "http://192.168.0.105:8080/audio.wav")
REDIS_URL     = os.getenv("REDIS_URL", "redis://redis:6379")
AUDIO_SECONDS = 10

# Mapa de cámaras por dispositivo
CAMARAS_AUDIO = {
    'PASILLO': 'http://192.168.2.192:8080/audio.wav',
    'Cancha': 'http://192.168.2.161:8080/audio.wav',
}

def get_cam_audio_url(device_id: str) -> str:
    return CAMARAS_AUDIO.get(device_id, CAM_AUDIO_URL)  # 3s es suficiente para detectar palabras clave

model    = None
executor = ThreadPoolExecutor(max_workers=2)

async def grabar_audio(segundos: int, url: str) -> str:
    print(f"[Transcription] Grabando {segundos}s de audio desde {url}...")
    tmp = tempfile.mktemp(suffix=".wav")
    timeout = aiohttp.ClientTimeout(total=segundos + 5)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as resp:
            data = b""
            inicio = asyncio.get_event_loop().time()
            async for chunk in resp.content.iter_chunked(8192):
                data += chunk
                if asyncio.get_event_loop().time() - inicio >= segundos:
                    break
    with open(tmp, "wb") as f:
        f.write(data)
    return tmp

def transcribir_sync(audio_path: str) -> str:
    try:
        segments, _ = model.transcribe(
            audio_path,
            language="es",
            beam_size=5,
            
            # 1. Filtro estricto: Si no es claramente una voz humana, ignóralo
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=400),
            
            # 2. Evita que la IA se quede "ciclada" repitiendo la misma palabra
            condition_on_previous_text=False,
            
            # 3. Le damos contexto para que no invente cosas raras con la estática
            initial_prompt="Emergencia en el campus universitario. Seguridad, ayuda, guardia, auxilio. ¿Hay alguien ahí?"
        )
        texto = " ".join(s.text.strip() for s in segments)
    except Exception as e:
        print(f"[Transcription] Error interno en Whisper: {e}")
        texto = ""
    finally:
        if os.path.exists(audio_path):
            os.unlink(audio_path)
            
    return texto
    # Corre en thread separado para no bloquear el event loop
    segments, _ = model.transcribe(
        audio_path,
        language="es",
        beam_size=1,        # más rápido (menos preciso pero suficiente)
        best_of=1,          # más rápido
        temperature=0.0,    # determinístico y más rápido
    )
    texto = " ".join(s.text.strip() for s in segments)
    os.unlink(audio_path)
    return texto

async def procesar_alerta(r, alerta: dict):
    alert_id  = alerta.get("alert_id", "unknown")
    device_id = alerta.get("device_id", "unknown")
    cam_url   = get_cam_audio_url(device_id)
    print(f"[Transcription] Procesando alerta: {alert_id} | dispositivo: {device_id} | cámara: {cam_url}")
    t0 = asyncio.get_event_loop().time()
    try:
        audio_path = await grabar_audio(AUDIO_SECONDS, cam_url)

        # Transcribir en thread para no bloquear
        loop = asyncio.get_event_loop()
        texto = await loop.run_in_executor(executor, transcribir_sync, audio_path)

        elapsed = asyncio.get_event_loop().time() - t0
        print(f"[Transcription] Listo en {elapsed:.1f}s: {texto}")

        payload = json.dumps({
            "alert_id": alert_id,
            "text":     texto,
            "timestamp": datetime.utcnow().isoformat()
        })
        await r.publish("channel:transcription", payload)
    except Exception as e:
        print(f"[Transcription] Error: {e}")

async def escuchar(r):
    print("[Transcription] Escuchando queue:transcription_input...")
    while True:
        try:
            result = await r.brpop("queue:transcription_input", timeout=5)
            if not result:
                continue
            alerta = json.loads(result[1])
            asyncio.create_task(procesar_alerta(r, alerta))
        except Exception as e:
            print(f"[Transcription] Error: {e} — reintentando en 2s...")
            await asyncio.sleep(2)

async def main():
    global model

    # Usar modelo tiny — 4x más rápido que small
    print("[Transcription] Cargando modelo Whisper tiny...")
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    print("[Transcription] Modelo listo")

    while True:
        try:
            print("[Transcription] Conectando a Redis...")
            r = redis.from_url(
                REDIS_URL,
                socket_connect_timeout=10,
                socket_keepalive=True,
                health_check_interval=30
            )
            await r.ping()
            print("[Transcription] Redis OK")
            break
        except Exception as e:
            print(f"[Transcription] Redis no disponible: {e} — reintentando en 3s...")
            await asyncio.sleep(3)

    await escuchar(r)

if __name__ == "__main__":
    asyncio.run(main())
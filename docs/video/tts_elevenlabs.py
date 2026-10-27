"""Generate narration with ElevenLabs: one WAV per scene from narration.json.

Usage: python docs/video/tts_elevenlabs.py <out_dir> [voice_id]
Reads ELEVENLABS_API_KEY from the environment (or the Windows user environment).
"""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "vo")
VOICE = sys.argv[2] if len(sys.argv) > 2 else "Xb7hH8MSUJpSbSDYk0k2"  # Alice: clear, engaging, British
MODEL = "eleven_multilingual_v2"
SCENES = json.loads((Path(__file__).parent / "narration.json").read_text(encoding="utf-8"))


def api_key() -> str:
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"]
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
        return winreg.QueryValueEx(k, "ELEVENLABS_API_KEY")[0]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    key = api_key()
    previous = ""
    for i, scene in enumerate(SCENES):
        following = SCENES[i + 1]["voice"] if i + 1 < len(SCENES) else ""
        body = {
            "text": scene["voice"],
            "model_id": MODEL,
            # Context from neighbouring lines keeps intonation consistent across separately generated clips.
            "previous_text": previous,
            "next_text": following,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "style": 0.15, "use_speaker_boost": True, "speed": 1.0},
        }
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=mp3_44100_192",
            data=json.dumps(body).encode(),
            headers={"xi-api-key": key, "content-type": "application/json", "accept": "audio/mpeg"},
        )
        mp3 = OUT / f"{scene['id']}.mp3"
        mp3.write_bytes(urllib.request.urlopen(req).read())
        wav = OUT / f"{scene['id']}.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(mp3), "-ar", "48000", "-ac", "1", str(wav)], check=True)
        dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)], capture_output=True, text=True).stdout.strip()
        print(f"{scene['id']}: {float(dur):5.2f}s", flush=True)
        previous = scene["voice"]


main()

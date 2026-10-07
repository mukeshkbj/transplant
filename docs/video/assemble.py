"""Assemble the Transplant demo film from logged takes, cards, captions and narration (ffmpeg only).

Usage: python docs/video/assemble.py <work_dir> <out.mp4>
  work_dir must contain takes/<take>/frames.json + JPEGs, cards/*.png, vo/s*.wav
"""

import json
import subprocess
import sys
from pathlib import Path

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else ".scratch/video")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "transplant-demo.mp4")
FPS = 30
VO_LEAD = 0.45
TAIL = 0.9
BUILD = WORK / "build"
BUILD.mkdir(parents=True, exist_ok=True)

# Footage segments are (take, start mark, start offset, end mark, end offset); waits are cut out.
SCENES = [
    {"id": "s0", "card": "s0"},
    {"id": "s1", "card": "s1"},
    {"id": "s2", "caption": "s2", "parts": [("main", "intake-visible", -0.7, "click:transplant", -0.4)]},
    {"id": "s3", "caption": "s3", "parts": [("main", "click:transplant", -0.4, "results-visible", 0.5), ("main", "map-settled", -0.1, "scroll-start:spots", 0.0)]},
    {"id": "s4", "caption": "s4", "parts": [("main", "scroll-start:spots", 0.0, "plan-hold-end", 0.0)]},
    {"id": "s5", "caption": "s5", "parts": [("main", "plan-hold-end", 0.0, "filtered-hold-end", 0.0)]},
    {"id": "s6", "caption": "s6", "parts": [("blend", "intake-visible", -0.6, "click:demo-blend", 0.9), ("blend", "map-settled", -0.1, "shared-hold-end", 0.0)]},
    {"id": "s7", "card": "s7"},
    {"id": "s8", "card": "s8"},
]


def run(args: list[str]):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"ffmpeg failed: {' '.join(args)[:300]}\n{result.stderr[-1500:]}")


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return float(out.stdout.strip())


def conform(take: str) -> tuple[Path, dict[str, float]]:
    """VFR screencast frames -> CFR 30 fps H.264; returns the video and mark times relative to its start."""
    folder = WORK / "takes" / take
    data = json.loads((folder / "frames.json").read_text())
    frames, t0 = data["frames"], data["frames"][0][1]
    last_mark = max(stamp for _, stamp in data["marks"])
    out = BUILD / f"take_{take}.mp4"
    if not out.exists():
        lines = []
        for i, (name, stamp) in enumerate(frames):
            nxt = frames[i + 1][1] if i + 1 < len(frames) else max(stamp, last_mark) + 1.0
            lines += [f"file '{(folder / name).resolve().as_posix()}'", f"duration {max(nxt - stamp, 0.001):.4f}"]
        lines.append(f"file '{(folder / frames[-1][0]).resolve().as_posix()}'")
        listing = BUILD / f"take_{take}.txt"
        listing.write_text("\n".join(lines) + "\n")
        run(["-f", "concat", "-safe", "0", "-i", str(listing), "-fps_mode", "cfr", "-r", str(FPS), "-vf", "scale=1920:1080,format=yuv420p", "-c:v", "libx264", "-crf", "14", "-preset", "medium", str(out)])
    return out, {label: stamp - t0 for label, stamp in data["marks"]}


def scene_clip(scene: dict, vo_len: float) -> tuple[Path, float]:
    out = BUILD / f"{scene['id']}.mp4"
    if "card" in scene:
        length = vo_len + VO_LEAD + TAIL + 0.4
        fade = f"fade=t=in:st=0:d=0.5,fade=t=out:st={length - 0.5:.2f}:d=0.5"
        run(["-loop", "1", "-t", f"{length:.2f}", "-i", str(WORK / "cards" / f"{scene['card']}.png"), "-vf", f"scale=1920:1080,format=yuv420p,{fade}", "-r", str(FPS), "-c:v", "libx264", "-crf", "16", str(out)])
        return out, length

    inputs, chains, labels, footage = [], [], [], 0.0
    for i, (take, m0, o0, m1, o1) in enumerate(scene["parts"]):
        video, marks = conform(take)
        start, end = max(0.0, marks[m0] + o0), marks[m1] + o1
        footage += end - start
        inputs += ["-i", str(video)]
        chains.append(f"[{i}:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[p{i}]")
        labels.append(f"[p{i}]")
    length = max(footage, vo_len + VO_LEAD + TAIL)
    hold = length - footage
    cap = len(scene["parts"])
    inputs += ["-loop", "1", "-t", f"{length:.2f}", "-i", str(WORK / "cards" / f"cap_{scene['caption']}.png")]
    graph = ";".join(chains)
    graph += f";{''.join(labels)}concat=n={len(labels)}:v=1:a=0,tpad=stop_mode=clone:stop_duration={hold + 0.05:.3f},trim=duration={length:.3f}[base]"
    graph += f";[{cap}:v]format=rgba,fade=t=in:st=0.6:d=0.4:alpha=1,fade=t=out:st={length - 0.5:.2f}:d=0.4:alpha=1[cap]"
    graph += ";[base][cap]overlay=0:0:shortest=1,format=yuv420p[v]"
    run([*inputs, "-filter_complex", graph, "-map", "[v]", "-r", str(FPS), "-c:v", "libx264", "-crf", "16", str(out)])
    return out, length


def main():
    clips, starts, t = [], [], 0.0
    for scene in SCENES:
        vo = WORK / "vo" / f"{scene['id']}.wav"
        clip, length = scene_clip(scene, duration(vo))
        clips.append(clip)
        starts.append((scene["id"], t, length))
        print(f"{scene['id']}: {t:6.2f}s +{length:5.2f}s")
        t += length
    total = t

    listing = BUILD / "scenes.txt"
    listing.write_text("".join(f"file '{c.resolve().as_posix()}'\n" for c in clips))
    picture = BUILD / "picture.mp4"
    run(["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(picture)])

    vo_inputs, vo_chain = [], []
    for i, (sid, start, _) in enumerate(starts):
        vo_inputs += ["-i", str(WORK / "vo" / f"{sid}.wav")]
        delay = int((start + VO_LEAD) * 1000)
        vo_chain.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={delay}|{delay}[v{i}]")
    n = len(starts)
    voice = BUILD / "voice.wav"
    run([*vo_inputs, "-filter_complex", ";".join(vo_chain) + f";{''.join(f'[v{i}]' for i in range(n))}amix=inputs={n}:normalize=0,apad=whole_dur={total:.2f},atrim=0:{total:.2f}[a]", "-map", "[a]", str(voice)])

    pad = BUILD / "pad.wav"
    notes = [110.0, 164.81, 220.0, 277.18, 329.63, 440.0]
    voices = "+".join(f"0.16*sin(2*PI*{f}*t)*(0.6+0.4*sin(2*PI*{0.05 + i * 0.013:.3f}*t+{i}))" for i, f in enumerate(notes))
    run(["-f", "lavfi", "-i", f"aevalsrc='{voices}|{voices.replace('sin(2*PI*', 'sin(2*PI*1.003*')}':s=48000:d={total:.2f}",
         "-af", f"lowpass=f=1400,aecho=0.8:0.7:120|260:0.35|0.25,afade=t=in:d=2.5,afade=t=out:st={total - 3:.2f}:d=3,volume=0.35", str(pad)])

    mix = BUILD / "mix.m4a"
    run(["-i", str(voice), "-i", str(pad), "-filter_complex",
         "[0:a]asplit=2[vo][key];[1:a][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[bed];[vo]volume=1.6[vox];[vox][bed]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]",
         "-map", "[a]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", str(mix)])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    run(["-i", str(picture), "-i", str(mix), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", str(OUT)])
    print(f"film: {OUT} ({duration(OUT):.1f}s, {OUT.stat().st_size / 1e6:.1f} MB)")
    (BUILD / "timeline.json").write_text(json.dumps(starts, indent=1))


main()

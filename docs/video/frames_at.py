"""Copy the frame shown at given offsets (seconds after a mark) for inspection.

Usage: python docs/video/frames_at.py <take_dir> <out_dir> <mark>[+offset] ...
"""

import bisect
import json
import shutil
import sys
from pathlib import Path

take, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
data = json.loads((take / "frames.json").read_text())
names = [f for f, _ in data["frames"]]
times = [t for _, t in data["frames"]]
marks = dict(data["marks"])

for spec in sys.argv[3:]:
    label, _, offset = spec.partition("+")
    t = marks[label] + float(offset or 0)
    i = max(0, bisect.bisect_right(times, t) - 1)
    dest = out / f"{take.name}_{label.replace(':', '-')}_{offset or '0'}.jpg"
    shutil.copy(take / names[i], dest)
    print(f"{spec:28s} -> frame {names[i]} at {times[i] - times[0]:6.2f}s  {dest.name}")

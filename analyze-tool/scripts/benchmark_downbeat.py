"""Phase accuracy of infer_downbeats (raw, phase_offset=0) vs committed ground truth."""
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np, librosa
sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from analyze_tool.advanced import infer_downbeats

ROOT = Path(__file__).resolve().parents[2]
gt = json.load(open(ROOT/'memo'/'structure-investigation'/'gt_phases.json', encoding='utf8'))
ok = 0; total = 0
for aj in sorted((ROOT/'data'/'analysis').glob('*.json')):
    d = json.load(open(aj, encoding='utf8')); tid = d['trackId']
    if tid not in gt: continue
    audio = ROOT/'data'/'sample'/d['source']['file']
    if not audio.exists(): audio = ROOT/'data'/'sample-excluded'/d['source']['file']
    y, sr = librosa.load(str(audio), sr=None, mono=True); dur = len(y)/sr
    beats = np.asarray(d['tempo']['beatsSeconds'], float)
    ch = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
    cht = librosa.frames_to_time(np.arange(ch.shape[1]), sr=sr, hop_length=512)
    _, phase = infer_downbeats(beats, ch, cht, dur)
    hit = phase == gt[tid]; ok += hit; total += 1
    off = (gt[tid] - phase) % 4; off = off - 4 if off > 2 else off
    print(f"{tid:<14} pred={phase} gt={gt[tid]} {'OK' if hit else f'MISS(off {off:+d})'}")
print(f"\nnew infer_downbeats: {ok}/{total} ({100*ok/total:.0f}%)  [old onset heuristic was 5/16=31%]")

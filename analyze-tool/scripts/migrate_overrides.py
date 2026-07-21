"""Regenerate overrides.json downbeat offsets for the new harmonic detector.

New required offset = (true_phase - new_auto_phase) mod 4, using the committed
ground-truth phase (which encodes the prior human audition). Active tracks are
recomputed; excluded tracks (no committed analysis to verify against) keep bpm +
rigidGrid but drop the now-stale offset. Nothing else is invented.
"""
from __future__ import annotations
import json, sys
from pathlib import Path
from collections import OrderedDict
import numpy as np, librosa
sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from analyze_tool.advanced import infer_downbeats

ROOT = Path(__file__).resolve().parents[2]
gt = json.load(open(ROOT/'memo'/'structure-investigation'/'gt_phases.json', encoding='utf8'))
ov_path = ROOT/'analyze-tool'/'overrides.json'
data = json.load(open(ov_path, encoding='utf8'))
tracks = data['tracks']

def track_id(fname): return fname.rsplit('.',1)[0].lower()

def new_phase(fname):
    for sub in ('sample','sample-excluded'):
        p = ROOT/'data'/sub/fname
        if p.exists(): break
    else:
        return None
    y, sr = librosa.load(str(p), sr=None, mono=True); dur=len(y)/sr
    # rebuild the exact rigid beat grid the provider would use
    from analyze_tool.advanced import rigid_beat_times
    ov = tracks[fname]; bpm=float(ov['bpm'])
    env = librosa.onset.onset_strength(y=y, sr=sr)
    beats = np.asarray(rigid_beat_times(env, sr, bpm, dur))
    ch = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
    cht = librosa.frames_to_time(np.arange(ch.shape[1]), sr=sr, hop_length=512)
    _, phase = infer_downbeats(beats, ch, cht, dur)
    return phase

def signed(needed):
    return needed - 4 if needed > 2 else needed  # map {3}->-1, keep {1,2}

new_tracks = OrderedDict()
report = []
for fname, ov in tracks.items():
    tid = track_id(fname)
    entry = {'bpm': ov['bpm']}
    if ov.get('rigidGrid'): entry['rigidGrid'] = True
    if tid in gt:
        pred = new_phase(fname)
        needed = signed((gt[tid] - pred) % 4)
        if needed != 0: entry['downbeatOffsetBeats'] = needed
        report.append((fname, ov.get('downbeatOffsetBeats',0), needed, f"auto={pred} gt={gt[tid]}"))
    else:
        report.append((fname, ov.get('downbeatOffsetBeats',0), 'drop(excluded)', 'no committed gt'))
    new_tracks[fname] = entry

json.dump({'tracks': new_tracks}, open(ov_path,'w',encoding='utf8'), indent=2, ensure_ascii=False)
open(ov_path,'a',encoding='utf8').write('\n')
print(f"{'file':<18}{'old':>5}{'new':>16}   note")
for f,o,n,note in report:
    print(f"{f:<18}{o:>5}{str(n):>16}   {note}")

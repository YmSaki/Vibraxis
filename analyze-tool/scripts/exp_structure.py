"""Experiment harness for structure boundary+label tuning (NOT the shipped path).

Loads committed bars (human-verified grid) + audio envelopes, runs parametrized
copies of the boundary/label logic, and either dumps per-bar features or plots
experimental sections. Once params converge, port them back into advanced.py.

Usage:
  exp_structure.py dump  <track_id...|all>          # per-bar features + boundaries
  exp_structure.py plot  <tag> <track_id...|all>    # PNG under plots_exp_<tag>/
"""
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np
import librosa
sys.path.insert(0, str(Path(__file__).parent))
from probe_features import ROOT, load_track, envelopes

# ------------------------------------------------------------------ features

def committed_bars(track_id: str):
    d = json.load(open(ROOT / 'data' / 'analysis' / f'{track_id}.json', encoding='utf8'))
    return (np.asarray(d['tempo']['barsSeconds'], float),
            np.asarray(d['tempo']['beatsSeconds'], float),
            float(d['tempo']['bpm']),
            d['structure']['sections'])


def bar_features(t, bars, e):
    """Per-bar means matching the provider's feature set."""
    dur = t.dur
    bar_starts = sorted(set([0.0, *[b for b in bars if b < dur]]))
    edges = [*bar_starts, dur]
    n = len(bar_starts)
    ft = e['t']
    cqt = librosa.feature.chroma_cqt(y=t.y, sr=t.sr, hop_length=512)
    ct = librosa.frames_to_time(np.arange(cqt.shape[1]), sr=t.sr, hop_length=512)

    def col(vals, times):
        out = np.zeros(n)
        for i in range(n):
            lo, hi = np.searchsorted(times, (edges[i], edges[i + 1]))
            if hi > lo:
                out[i] = float(np.mean(vals[lo:hi]))
        return out

    level = col(e['rms'], ft)
    low = col(e['low'], ft)
    dens = col(e['onset'], ft)
    cent = col(e['centroid'], ft)
    chroma = np.zeros((12, n))
    for i in range(n):
        lo, hi = np.searchsorted(ct, (edges[i], edges[i + 1]))
        if hi > lo:
            chroma[:, i] = np.mean(cqt[:, lo:hi], axis=1)
    return bar_starts, {"level": level, "low": low, "dens": dens, "cent": cent, "chroma": chroma}


def relative(v):
    lo, hi = np.percentile(v, 5), np.percentile(v, 95)
    return np.clip((v - lo) / (hi - lo + 1e-9), 0.0, 1.0)

# ------------------------------------------------------------------ boundaries (parametrized)

def boundaries(feats, *, min_bars=4, kick_hi=0.50, kick_lo=0.34, min_off=2, novelty_pct=78):
    """Kick-state (schmitt + min-off-run) union novelty peaks, min spacing."""
    level, low = feats["level"], feats["low"]
    n = len(level)
    if n < 2 * min_bars:
        return [0, n]
    low_rel = relative(low)
    k = np.ones(3) / 3.0
    slow = np.convolve(low_rel, k, mode="same")
    # Schmitt trigger with a minimum off-run so brief kick gaps don't flip.
    state = np.ones(n, int)
    cur = 1
    run = 0
    for i in range(n):
        if cur == 1:
            if slow[i] < kick_lo:
                run += 1
                if run >= min_off:
                    cur = 0
                    state[max(0, i - run + 1):i + 1] = 0
            else:
                run = 0
        else:
            if slow[i] > kick_hi:
                cur = 1
                run = 0
        state[i] = cur
    flips = [i for i in range(1, n) if state[i] != state[i - 1]]

    rows = [relative(level), low_rel, relative(feats["dens"]), relative(feats["cent"])]
    mat = np.vstack([*rows, feats["chroma"]]).T
    sm = np.vstack([np.convolve(mat[:, j], k, mode="same") for j in range(mat.shape[1])]).T
    std = (sm - sm.mean(axis=0)) / (sm.std(axis=0) + 1e-9)
    nov = np.linalg.norm(np.diff(std, axis=0, prepend=std[:1]), axis=1)
    thr = float(np.percentile(nov, novelty_pct))
    peaks = [i for i in range(min_bars, n - min_bars // 2)
             if nov[i] >= thr and nov[i] == np.max(nov[max(0, i - 2):i + 3])]

    kept = []
    for i in sorted(set(flips) | set(peaks)):
        if 0 < i < n and (not kept or i - kept[-1] >= min_bars):
            kept.append(i)
    return sorted(set([0, *kept, n])), state, low_rel

# ------------------------------------------------------------------ labels (parametrized)

def seg_slope(v):
    if len(v) < 3:
        return 0.0
    x = np.arange(len(v))
    return float(np.polyfit(x, v, 1)[0]) * len(v) / (float(np.mean(v)) + 1e-9)


def label(feats, bnds, bpm, *, edm=(120, 180)):
    level, low, chroma = feats["level"], feats["low"], feats["chroma"]
    count = len(bnds) - 1
    peak = float(level.max()) + 1e-9
    if count <= 1:
        return ["other"], [float(level.mean() / peak)], [0.3]
    recs = []
    for s in range(count):
        a, b = bnds[s], bnds[s + 1]
        recs.append({"level": float(np.mean(level[a:b])), "low": float(np.mean(low[a:b])),
                     "slope": seg_slope(level[a:b]), "cslope": seg_slope(feats["cent"][a:b]),
                     "chroma": np.mean(chroma[:, a:b], axis=1), "nbars": b - a})
    sl = np.array([r["level"] for r in recs]); slo = np.array([r["low"] for r in recs])

    def rs(v):
        return (v - v.min()) / (float(v.max() - v.min()) + 1e-9)
    lr = rs(sl); lowr = rs(slo); med = float(np.median(lr))

    def cos(u, v):
        return float(u @ v / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9))
    recur = [any(cos(recs[k]["chroma"], recs[j]["chroma"]) > 0.9 and abs(lr[k] - lr[j]) < 0.2
                 for j in range(k)) for k in range(count)]
    edmish = bpm is not None and edm[0] <= bpm <= edm[1]
    labels, energies, confs = [], [], []
    for k in range(count):
        this, kick, slope = lr[k], lowr[k], recs[k]["slope"]
        prev = lr[k - 1] if k > 0 else None
        nxt = lr[k + 1] if k + 1 < count else None
        is_high = this >= 0.6 and kick >= 0.45
        is_low = this <= 0.4 or kick <= 0.35
        conf = 0.45
        if k == 0 and this <= 0.55:
            lab, conf = "intro", 0.6
        elif k == count - 1 and (this <= 0.45 or kick <= 0.35):
            lab, conf = "outro", 0.6
        elif is_low and 0 < k < count - 1 and ((prev is not None and prev > this + 0.15) or (nxt is not None and nxt > this + 0.15)):
            lab, conf = "breakdown", 0.5
        elif slope > 0.3 and nxt is not None and nxt > this + 0.05 and recs[k]["cslope"] >= 0:
            lab, conf = "build", 0.5
        elif is_high:
            cfb = prev is not None and (recs[k - 1]["slope"] > 0.3 or prev < this - 0.2)
            if cfb and edmish:
                lab, conf = "drop", 0.5
            elif recur[k] or this >= 0.85:
                lab, conf = "chorus", 0.45
            else:
                lab, conf = "verse", 0.4
        else:
            lab, conf = ("verse", 0.4) if this >= med else ("breakdown", 0.4)
        labels.append(lab); energies.append(float(sl[k] / peak)); confs.append(conf)
    return labels, energies, confs


def merge(bnds, labels, energies, confs):
    out = []
    for s in range(len(bnds) - 1):
        r = {"b0": bnds[s], "b1": bnds[s + 1], "label": labels[s], "energy": energies[s], "conf": confs[s]}
        if out and out[-1]["label"] == r["label"]:
            out[-1]["b1"] = r["b1"]; out[-1]["energy"] = max(out[-1]["energy"], r["energy"]); out[-1]["conf"] = max(out[-1]["conf"], r["conf"])
        else:
            out.append(r)
    return out

# ------------------------------------------------------------------ drivers

def run(t, bars, bpm, params):
    bar_starts, feats = bar_features(t, bars, envelopes(t))
    bnds, state, low_rel = boundaries(feats, **{k: v for k, v in params.items() if k in ('min_bars', 'kick_hi', 'kick_lo', 'min_off', 'novelty_pct')})
    labels, energies, confs = label(feats, bnds, bpm)
    merged = merge(bnds, labels, energies, confs)
    return bar_starts, feats, bnds, state, low_rel, merged


def secs_from_merged(bar_starts, dur, merged):
    out = []
    for r in merged:
        s = bar_starts[r["b0"]]
        en = dur if r["b1"] >= len(bar_starts) else bar_starts[r["b1"]]
        out.append({"label": r["label"], "startSeconds": s, "endSeconds": en, "energy": r["energy"]})
    return out


PARAMS = dict(min_bars=4, kick_hi=0.50, kick_lo=0.34, min_off=2, novelty_pct=78)

if __name__ == '__main__':
    mode = sys.argv[1]
    ajs = sorted((ROOT / 'data' / 'analysis').glob('*.json'))
    if mode == 'dump':
        which = sys.argv[2:] or ['all']
        if which != ['all']:
            ajs = [a for a in ajs if a.stem in which]
        for aj in ajs:
            t = load_track(aj)
            bars, beats, bpm, committed = committed_bars(t.track_id)
            bar_starts, feats, bnds, state, low_rel, merged = run(t, bars, bpm, PARAMS)
            print(f"\n=== {t.track_id}  bpm={bpm:.0f} dur={t.dur:.0f}s nbars={len(bar_starts)} ===")
            print("committed:", [(s['label'], round(s['startSeconds'], 1), round(s['endSeconds'], 1)) for s in committed])
            print("exp      :", [(r['label'], round(bar_starts[r['b0']], 1),
                                  round(t.dur if r['b1'] >= len(bar_starts) else bar_starts[r['b1']], 1)) for r in merged])
            print("kick_on/off state per bar:", ''.join(str(x) for x in state))
            print("low_rel per bar:", ' '.join(f"{x:.2f}" for x in low_rel))
    elif mode == 'plot':
        tag = sys.argv[2]
        which = sys.argv[3:] or ['all']
        if which != ['all']:
            ajs = [a for a in ajs if a.stem in which]
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from matplotlib.patches import Rectangle
        sys.path.insert(0, str(Path(__file__).parent))
        import plot_structure as ps
        outdir = ROOT / 'memo' / 'structure-investigation' / f'plots_exp_{tag}'
        outdir.mkdir(parents=True, exist_ok=True)
        for aj in ajs:
            t = load_track(aj)
            bars, beats, bpm, committed = committed_bars(t.track_id)
            bar_starts, feats, bnds, state, low_rel, merged = run(t, bars, bpm, PARAMS)
            secs = secs_from_merged(bar_starts, t.dur, merged)
            ps.plot_track(t, secs, outdir / f'{t.track_id}.png', title_extra=f'[exp:{tag}]')
            print('plotted', t.track_id)

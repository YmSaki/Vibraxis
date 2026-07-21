"""Boundary-detection experiments, scored against human annotations (NOT shipped).

Human ground truth = memo/structure-investigation/section-annotations.json.
All boundaries live on the (human-verified) bar grid; the human places section
changes overwhelmingly on the 4/8-bar phrase grid. We try several selection
methods over per-bar novelty and score boundary P/R/F1 at a 1-bar tolerance
(adjacent same-label human segments merged first, so only real changes count).

Usage: uv run python scripts/exp_boundaries.py
"""
from __future__ import annotations
import sys, json
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from probe_features import ROOT, load_track, envelopes
from exp_structure import committed_bars, bar_features, relative

ANN = json.load(open(ROOT / "memo" / "structure-investigation" / "section-annotations.json", encoding="utf8"))["annotations"]


def merge_same_label(secs):
    out = []
    for s in secs:
        st, en, lab = s.get("start", s.get("startSeconds")), s.get("end", s.get("endSeconds")), s.get("label")
        if out and out[-1]["label"] == lab:
            out[-1]["end"] = en
        else:
            out.append({"start": st, "end": en, "label": lab})
    return out


def human_boundaries(tid, dur):
    h = merge_same_label(ANN[tid]["sections"])
    return [s["start"] for s in h if 0.05 < s["start"] < dur - 0.05]


def per_bar_novelty(feats):
    rows = [relative(feats["level"]), relative(feats["low"]), relative(feats["dens"]), relative(feats["cent"])]
    mat = np.vstack([*rows, feats["chroma"]]).T
    k = np.ones(3) / 3.0
    sm = np.vstack([np.convolve(mat[:, j], k, mode="same") for j in range(mat.shape[1])]).T
    std = (sm - sm.mean(axis=0)) / (sm.std(axis=0) + 1e-9)
    return np.linalg.norm(np.diff(std, axis=0, prepend=std[:1]), axis=1)


def kick_flips(feats, thr=0.42):
    low_rel = relative(feats["low"])
    sm = np.convolve(low_rel, np.ones(3) / 3.0, mode="same")
    on = (sm > thr).astype(int)
    return [i for i in range(1, len(on)) if on[i] != on[i - 1]]

# ---------------------------------------------------------------- methods (return internal bar indices)

def m_current(feats, nbars, novelty, **kw):
    """Reproduce the shipped detector: kick flips U novelty peaks(75pct), min 4-bar spacing."""
    thr = float(np.percentile(novelty, 75))
    peaks = [i for i in range(4, nbars - 2) if novelty[i] >= thr and novelty[i] == np.max(novelty[max(0, i - 2):i + 3])]
    kept = []
    for i in sorted(set(kick_flips(feats)) | set(peaks)):
        if 0 < i < nbars and (not kept or i - kept[-1] >= 4):
            kept.append(i)
    return kept


def m_phrase(feats, nbars, novelty, *, grid=4, thr_pct=65, offset_search=True, **kw):
    """Candidates on the phrase grid (every `grid` bars, best phase); pick high-novelty lines."""
    best_off, best_sum = 0, -1
    offs = range(grid) if offset_search else [0]
    for off in offs:
        cand = [i for i in range(grid, nbars - grid // 2) if (i - off) % grid == 0]
        s = sum(novelty[i] for i in cand)
        if s > best_sum:
            best_sum, best_off = s, off
    cand = [i for i in range(grid, nbars - grid // 2) if (i - best_off) % grid == 0]
    thr = float(np.percentile(novelty, thr_pct))
    kept = []
    for i in cand:
        score = float(np.max(novelty[max(0, i - 1):i + 2]))
        if score >= thr and (not kept or i - kept[-1] >= grid):
            kept.append(i)
    return kept


def m_phrase_kick(feats, nbars, novelty, *, grid=4, thr_pct=65, **kw):
    """Phrase-grid novelty selection UNION strong kick-state flips (snapped to nearest grid line)."""
    base = set(m_phrase(feats, nbars, novelty, grid=grid, thr_pct=thr_pct, offset_search=True))
    for f in kick_flips(feats):
        base.add(int(round(f / grid) * grid) if grid > 1 else f)
    kept = []
    for i in sorted(x for x in base if 0 < x < nbars):
        if not kept or i - kept[-1] >= grid:
            kept.append(i)
    return kept

# ---------------------------------------------------------------- scoring

def match(det, ref, tol):
    used = [False] * len(ref)
    m = 0
    for d in det:
        best, bd = -1, tol
        for i, r in enumerate(ref):
            if not used[i] and abs(d - r) <= bd:
                bd, best = abs(d - r), i
        if best >= 0:
            used[best] = True
            m += 1
    return m


def prf(m, nd, nr):
    p = m / nd if nd else (1.0 if nr == 0 else 0.0)
    r = m / nr if nr else (1.0 if nd == 0 else 0.0)
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def evaluate(method, params, tracks):
    agg = {"m": 0, "nd": 0, "nr": 0}
    per = {}
    for tid, data in tracks.items():
        feats, bar_starts, dur, bpm = data
        nbars = len(bar_starts)
        nov = per_bar_novelty(feats)
        idx = method(feats, nbars, nov, **params)
        det = [bar_starts[i] for i in idx if 0 < i < nbars]
        ref = human_boundaries(tid, dur)
        tol = 4 * 60.0 / bpm
        m = match(det, ref, tol)
        agg["m"] += m; agg["nd"] += len(det); agg["nr"] += len(ref)
        per[tid] = prf(m, len(det), len(ref))[2]
    p, r, f = prf(agg["m"], agg["nd"], agg["nr"])
    return p, r, f, per


def main():
    tracks = {}
    for tid in sorted(ANN):
        aj = ROOT / "data" / "analysis" / f"{tid}.json"
        if not aj.exists():
            continue
        t = load_track(aj)
        bars, beats, bpm, _ = committed_bars(tid)
        bar_starts, feats = bar_features(t, bars, envelopes(t))
        tracks[tid] = (feats, bar_starts, t.dur, bpm)

    configs = [
        ("current (shipped)", m_current, {}),
        ("phrase g4 p65 off", m_phrase, {"grid": 4, "thr_pct": 65, "offset_search": True}),
        ("phrase g4 p55 off", m_phrase, {"grid": 4, "thr_pct": 55, "offset_search": True}),
        ("phrase g4 p65 nooff", m_phrase, {"grid": 4, "thr_pct": 65, "offset_search": False}),
        ("phrase g2 p70 off", m_phrase, {"grid": 2, "thr_pct": 70, "offset_search": True}),
        ("phrase g2 p60 off", m_phrase, {"grid": 2, "thr_pct": 60, "offset_search": True}),
        ("phrase+kick g4 p65", m_phrase_kick, {"grid": 4, "thr_pct": 65}),
        ("phrase+kick g2 p65", m_phrase_kick, {"grid": 2, "thr_pct": 65}),
    ]
    print(f"{'method':22s} {'P':>5s} {'R':>5s} {'F1':>5s}")
    results = {}
    for name, meth, params in configs:
        p, r, f, per = evaluate(meth, params, tracks)
        results[name] = per
        print(f"{name:22s} {p*100:5.1f} {r*100:5.1f} {f*100:5.1f}")
    # per-track F1 for the two most interesting methods vs current
    print("\nper-track F1:")
    cols = ["current (shipped)", "phrase g4 p65 off", "phrase g2 p60 off", "phrase+kick g2 p65"]
    print(f"{'track':14s} " + " ".join(f"{c.split()[0][:6]+c.split()[-1][:4]:>11s}" for c in cols))
    for tid in sorted(tracks):
        print(f"{tid:14s} " + " ".join(f"{results[c][tid]*100:11.0f}" for c in cols))


if __name__ == "__main__":
    main()

"""Benchmark the shipped structure detector against human annotations.

Ground truth = memo/structure-investigation/section-annotations.json (from
section-check.html). Measures, objectively and reproducibly:
  1. Boundary detection  — precision/recall/F1 of section-change points, at a
     1-bar tolerance and a fixed 2s tolerance (adjacent same-label human
     segments are merged first, so only real section changes count).
  2. Label agreement     — duration-weighted frame accuracy of the label at
     each instant, plus a confusion tally (human -> detector) to expose
     systematic swaps (e.g. detector "chorus" where the human hears "drop").

The detector output evaluated is the committed data/analysis/*.json sections
(i.e. what infer_structure currently ships). Nothing here modifies the detector;
it only measures it. Usage: uv run python scripts/benchmark_structure.py
"""
from __future__ import annotations
import json, sys
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[2]
ANN = ROOT / "memo" / "structure-investigation" / "section-annotations.json"
ANALYSIS = ROOT / "data" / "analysis"


def merge_same_label(secs):
    """Collapse adjacent segments carrying the same label into one section."""
    out = []
    for s in secs:
        lab = s.get("label")
        st = s.get("start", s.get("startSeconds"))
        en = s.get("end", s.get("endSeconds"))
        if out and out[-1]["label"] == lab:
            out[-1]["end"] = en
        else:
            out.append({"start": st, "end": en, "label": lab})
    return out


def internal_boundaries(secs, dur):
    return [s["start"] for s in secs if s["start"] > 0.05 and s["start"] < dur - 0.05]


def match_boundaries(det, ref, tol):
    """Greedy one-to-one match within tol. Returns matched count."""
    used = [False] * len(ref)
    matched = 0
    for d in det:
        best, bd = -1, tol
        for i, r in enumerate(ref):
            if used[i]:
                continue
            if abs(d - r) <= bd:
                bd, best = abs(d - r), i
        if best >= 0:
            used[best] = True
            matched += 1
    return matched


def label_at(secs, t):
    for s in secs:
        if s["start"] <= t < s["end"]:
            return s["label"]
    return secs[-1]["label"] if secs else None


def prf(matched, ndet, nref):
    p = matched / ndet if ndet else (1.0 if nref == 0 else 0.0)
    r = matched / nref if nref else (1.0 if ndet == 0 else 0.0)
    f = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f


def main():
    ann = json.load(open(ANN, encoding="utf8"))["annotations"]
    rows = []
    agg = {"m_bar": 0, "m_2s": 0, "ndet": 0, "nref": 0, "lab_ok": 0.0, "lab_tot": 0.0}
    confusion = Counter()
    STEP = 0.1

    for tid in sorted(ann):
        aj = ANALYSIS / f"{tid}.json"
        if not aj.exists():
            continue
        d = json.load(open(aj, encoding="utf8"))
        bpm = float(d["tempo"]["bpm"])
        bar = 4 * 60.0 / bpm
        dur = ann[tid]["duration"]

        human = merge_same_label(ann[tid]["sections"])
        det = merge_same_label(d["structure"]["sections"])
        hb = internal_boundaries(human, dur)
        db = internal_boundaries(det, dur)

        m_bar = match_boundaries(db, hb, bar)          # tolerance = 1 bar
        m_2s = match_boundaries(db, hb, 2.0)            # tolerance = 2 seconds
        p, r, f = prf(m_bar, len(db), len(hb))

        # duration-weighted label frame accuracy (skip frames the human left null)
        ok = tot = 0
        t = 0.0
        while t < dur:
            hl = label_at(human, t)
            if hl is not None:
                dl = label_at(det, t)
                tot += 1
                if dl == hl:
                    ok += 1
                confusion[(hl, dl)] += 1
            t += STEP
        lab_acc = ok / tot if tot else 0.0

        rows.append((tid, len(hb) + 1, len(db) + 1, m_bar, len(hb), f, lab_acc))
        agg["m_bar"] += m_bar; agg["m_2s"] += m_2s
        agg["ndet"] += len(db); agg["nref"] += len(hb)
        agg["lab_ok"] += ok; agg["lab_tot"] += tot

    print("=== per-track ===")
    print(f"{'track':14s} {'hSec':>4s} {'dSec':>4s} {'bnd(1bar)':>9s} {'F1':>5s} {'labelAcc':>8s}")
    for tid, hs, ds, mb, nref, f, la in rows:
        print(f"{tid:14s} {hs:4d} {ds:4d} {mb:>4d}/{nref:<4d} {f:5.2f} {la*100:7.1f}%")

    p, r, f = prf(agg["m_bar"], agg["ndet"], agg["nref"])
    p2, r2, f2 = prf(agg["m_2s"], agg["ndet"], agg["nref"])
    print("\n=== aggregate (micro over all boundaries) ===")
    print(f"boundary @1-bar tol : P={p*100:.1f}% R={r*100:.1f}% F1={f*100:.1f}%  ({agg['m_bar']}/{agg['nref']} ref hit, {agg['ndet']} det)")
    print(f"boundary @2s   tol : P={p2*100:.1f}% R={r2*100:.1f}% F1={f2*100:.1f}%")
    print(f"label frame acc    : {agg['lab_ok']/agg['lab_tot']*100:.1f}%  (duration-weighted, null human frames skipped)")

    print("\n=== confusion (human -> detector), top swaps by track-seconds ===")
    total = sum(confusion.values())
    diag = sum(v for (h, dd), v in confusion.items() if h == dd)
    print(f"agreement on diagonal: {diag/total*100:.1f}% of labeled seconds")
    for (h, dd), v in confusion.most_common(18):
        tag = "  OK" if h == dd else ("  <-- miss" if v * STEP > 8 else "")
        print(f"  {str(h):11s} -> {str(dd):11s} {v*STEP:6.1f}s{tag}")


if __name__ == "__main__":
    main()

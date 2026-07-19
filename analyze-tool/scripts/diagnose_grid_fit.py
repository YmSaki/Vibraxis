"""Diagnose how well each track's real audio fits its rigid beat grid.

For every beat in the emitted grid, find the strongest onset peak within
±half a period and record the residual (peak time − grid time). Reports:
- med|res|  : median absolute residual (overall fit quality)
- drift     : linear slope of residual over time (ms per second).
              A steady slope means the nominal BPM is slightly off:
              bpm_true ≈ bpm / (1 + slope/1000).
- even/odd  : median residual on even vs odd beats (swing shows up as a
              consistent split between the two).
Diagnostic only; writes nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

DATA = Path(__file__).resolve().parents[2] / "data"


def main() -> int:
    for path in sorted((DATA / "analysis").glob("*.json")):
        record = json.loads(path.read_text(encoding="utf8"))
        beats = np.asarray(record["tempo"]["beatsSeconds"], dtype=float)
        bpm = float(record["tempo"]["bpm"])
        period = 60.0 / bpm
        audio = DATA / "sample" / record["source"]["file"]
        samples, sample_rate = librosa.load(audio, sr=None, mono=True)
        envelope = librosa.onset.onset_strength(y=samples, sr=sample_rate)
        env_times = librosa.frames_to_time(np.arange(len(envelope)), sr=sample_rate)

        residuals = np.full(len(beats), np.nan)
        strengths = np.zeros(len(beats))
        for index, beat in enumerate(beats):
            low, high = np.searchsorted(env_times, [beat - period / 2, beat + period / 2])
            if high - low < 3:
                continue
            segment = envelope[low:high]
            peak = int(np.argmax(segment))
            residuals[index] = env_times[low + peak] - beat
            strengths[index] = segment[peak]

        # Keep only beats whose onset peak is reasonably strong (top 60%),
        # so quiet passages do not swamp the statistics with noise.
        valid = ~np.isnan(residuals)
        threshold = np.percentile(strengths[valid], 40)
        keep = valid & (strengths >= threshold)
        r = residuals[keep]
        t = beats[keep]
        med = float(np.median(np.abs(r))) * 1000
        slope = float(np.polyfit(t, r, 1)[0]) * 1000 if len(t) > 8 else float("nan")
        even = float(np.median(r[::2])) * 1000
        odd = float(np.median(r[1::2])) * 1000
        bpm_true = bpm / (1 + slope / 1000) if np.isfinite(slope) else float("nan")
        print(
            f"{record['trackId']:<12} med|res|={med:5.1f}ms drift={slope:+6.3f}ms/s "
            f"(bpm_true~{bpm_true:7.3f}) even={even:+5.1f}ms odd={odd:+5.1f}ms n={len(r)}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

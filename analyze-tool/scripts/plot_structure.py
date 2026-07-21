"""Render feature envelopes with section overlays, to judge structure by shape.

Usage: plot_structure.py <sections_mode> <track_id...|all>
  sections_mode: committed | none
Outputs PNG per track under memo/structure-investigation/plots_<mode>/.
"""
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
sys.path.insert(0, str(Path(__file__).parent))
from probe_features import ROOT, load_track, envelopes, onset_density

LABEL_COLORS = {
    'intro':'#8ecae6','verse':'#a3b18a','preChorus':'#c9a227','chorus':'#e07a5f',
    'build':'#f4a261','drop':'#e63946','breakdown':'#457b9d','bridge':'#b5838d',
    'instrumental':'#adb5bd','outro':'#6c757d','other':'#ced4da',
}

def norm(x):
    x = np.asarray(x, float); lo, hi = np.percentile(x, 2), np.percentile(x, 98)
    return np.clip((x-lo)/(hi-lo+1e-9), 0, 1)

def committed_sections(track_id):
    d = json.load(open(ROOT/'data'/'analysis'/f'{track_id}.json', encoding='utf8'))
    return d['structure']['sections']

def plot_track(t, sections, out_png, title_extra=''):
    e = envelopes(t); gt, dens = onset_density(t)
    fig, axes = plt.subplots(3, 1, figsize=(16, 8), sharex=True)
    # panel 0: RMS(fill) + low-band + onset-density
    ax = axes[0]
    ax.fill_between(e['t'], 0, norm(e['rms']), color='#222', alpha=0.18, label='RMS')
    ax.plot(e['t'], norm(e['low']), color='#e63946', lw=1.1, label='low<150Hz (kick/bass)')
    ax.plot(gt, norm(dens), color='#2a9d8f', lw=1.1, label='onset density')
    ax.set_ylabel('energy/activity'); ax.legend(loc='upper right', fontsize=7, ncol=3)
    # panel 1: centroid + high band + flux
    ax1 = axes[1]
    ax1.plot(e['t'], norm(e['centroid']), color='#6a4c93', lw=1.0, label='centroid (brightness)')
    ax1.plot(e['t'], norm(e['high']), color='#f4a261', lw=0.9, label='high>4kHz')
    ax1.plot(e['t'], norm(e['flux']), color='#888', lw=0.7, alpha=0.7, label='spectral flux')
    ax1.set_ylabel('spectral'); ax1.legend(loc='upper right', fontsize=7, ncol=3)
    # panel 2: section band
    ax2 = axes[2]
    for s in sections:
        c = LABEL_COLORS.get(s['label'], '#ccc')
        ax2.add_patch(Rectangle((s['startSeconds'],0),
                     s['endSeconds']-s['startSeconds'], 1, color=c, alpha=0.75))
        mid = (s['startSeconds']+s['endSeconds'])/2
        ax2.text(mid, 0.5, f"{s['label']}\n{s.get('energy',0):.2f}",
                 ha='center', va='center', fontsize=7, weight='bold')
    ax2.set_ylim(0,1); ax2.set_yticks([]); ax2.set_ylabel('sections')
    # boundaries + downbeats on all panels
    for a in axes:
        for s in sections:
            a.axvline(s['startSeconds'], color='k', lw=0.6, alpha=0.35)
        a.set_xlim(0, t.dur)
    for db in t.downbeats:
        axes[0].axvline(db, color='#2a9d8f', lw=0.25, alpha=0.25)
    axes[-1].set_xlabel('seconds')
    fig.suptitle(f"{t.track_id}  bpm={t.bpm:.0f}  dur={t.dur:.0f}s  {title_extra}", fontsize=11)
    fig.tight_layout(rect=[0,0,1,0.98])
    fig.savefig(out_png, dpi=90); plt.close(fig)

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'committed'
    which = sys.argv[2:] or ['all']
    outdir = ROOT/'memo'/'structure-investigation'/f'plots_{mode}'
    outdir.mkdir(parents=True, exist_ok=True)
    ajs = sorted((ROOT/'data'/'analysis').glob('*.json'))
    if which != ['all']:
        ajs = [a for a in ajs if a.stem in which]
    for aj in ajs:
        t = load_track(aj)
        secs = committed_sections(t.track_id) if mode=='committed' else []
        plot_track(t, secs, outdir/f'{t.track_id}.png', title_extra=f'[{mode}]')
        print('plotted', t.track_id)

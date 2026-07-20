# Autonomous DJ Model — canonical spec

Status: **authoritative**. This is the canon that code, tests, and UI decisions must
reference. Claude's internal memory is not a specification; this file (with
[`conductor-state-machine.md`](conductor-state-machine.md) and
[`request-semantics.md`](request-semantics.md)) is. If the implementation and this
doc disagree, the doc wins and the implementation is a bug — fix one or the other in
lockstep (AGENTS.md §0).

## 1. Identity

Vibraxis is **NOT** "DJ-assist software where the AI proposes a mix and a human
applies it." It **IS** a *resident DJ*: given audio sources, it autonomously and
continuously selects, prepares, transitions, and plays, and it absorbs human input as
**future selection policy and requests** — never as per-mix approval.

## 2. Invariants (normative)

1. Vibraxis continues selection / playback / transition **without per-step user
   approval**.
2. A user track request is, by default, **added to the provisional request queue**
   (see §4), not played immediately.
3. A request is **not an immediate-play command** — the DJ consumes it at a musically
   appropriate time.
4. Mood / genre / era / energy instructions are reflected as **selection-score or
   play-plan constraints**, not one-shot picks.
5. Normal selection/transition **must NOT require APPLY / CONFIRM / any approval**.
6. What is surfaced to the user is **not an approval request** but: current playback
   state, the committed next track, the provisional queue, the reflected policy, and
   the reason any request was rejected.
7. The user is **notified only when a request cannot be executed** (unplayable, track
   absent, contradictory hard constraint, analysis missing, etc.).

## 3. Two-deep thinking ≠ two-deep fixing

A DJ *thinks* about the next track **and** the track after it, but only *commits* the
immediate next. Committing the next-next is too rigid — later requests and session
changes could no longer be reflected. The canonical state model:

| Slot | Meaning | Mutability |
| ---- | ------- | ---------- |
| `currentTrack` | playing now; confirmed | fixed until it ends / is transitioned away |
| `committedNextTrack` | chosen as next; **loaded, CUE-set, transition-planned**, waiting | replaced only by an explicit "play this next" or a safety/force path |
| `provisionalQueue[0..N]` | candidates for next-next onward | **re-evaluable** — requests and policy changes rewrite it |

- `committedNextTrack` carries a full transition plan (§5), not just a track id.
- `provisionalQueue` is recomputed as policy/requests change; it is never "fixed."
- Default request landing point is the provisional queue (§6, and
  [`request-semantics.md`](request-semantics.md)).

## 4. Planner / Executor separation

The current implementation (a single reactive loop that decides the next track *at*
the outro and loads it last-second) is the wrong base. The correct decomposition
splits **planning** from **execution**:

```
Planner:   selection plan ──▶ transition plan ──▶ committedNextTrack (prepared)
Executor:  deck preparation ──▶ transition-condition monitor ──▶ execute ──▶ promote & replan
```

- **Planner** decides *what* comes next and *how* the transition should look, ahead of
  time, producing a fully-prepared `committedNextTrack`.
- **Executor** owns deck preparation, watches for the musical firing condition,
  executes the beat-matched transition, then promotes the next track and asks the
  Planner to plan again.

"How many seconds before the end to load" is **not** the change we need; **separating
Planner and Executor** is. The state machine that formalizes this lives in
[`conductor-state-machine.md`](conductor-state-machine.md).

## 5. A transition is a plan, not a single cue point

Preparing `committedNextTrack` means computing a transition plan with at least:

```
sourceExitPoint        where the current track stops contributing
targetCuePoint         where the next track starts (its intro)
transitionStart        when the blend begins
transitionDurationBars length of the blend, in bars
beatPhaseAlignment     bar/phrase phase match between the two grids
tempoAdjustment        playback-rate / tempo-sync to reconcile BPM
gainPlan               channel-fader ride, if any
eqPlan                 bass-swap / EQ blend across the phrase (not implemented yet)
crossfaderCurve        equal-power / dj curve
protectedSections      sections that must not be cut once started (§6)
```

Illustrative:

```
current:  OUTRO starts bar 97 · transition starts bar 105 · full exit bar 121
next:     CUE = INTRO bar 1 · vocal bar 17 · DROP bar 33
blend:    16 bars · bass swap at bar 113 · crossfade complete bar 121
```

"Load at the outro and crossfade" is too coarse to be the DJ's planning model.

## 6. Protected sections — default, with exceptions

Default principle: **the A-melody → B-melody → chorus arc (in EDM terms
buildup → drop) plays by default; a normal transition never cuts a protected section
that has already started.** The current track's drop is allowed to land.

But this is a default, not a literal absolute. A protected section **may** be
interrupted by:

- an explicit immediate **skip**,
- **PANIC** / immediate stop,
- **playback anomaly** — silence, corruption, decode failure,
- **inaccurate/absent section analysis**,
- an **extremely long** structure,
- an explicit **manual override**,
- a **banned-track / venue-policy** detection.

Canonical rule: *In normal transitions, do not cut a protected section that has
started. Safety operations, explicit force operations, and playback anomalies may
interrupt it.*

Firing-condition priority (Executor):

```
analyzed section boundary  (primary)
  ↓ if unavailable
phrase / bar boundary
  ↓ if unavailable
time-remaining fallback     (only when structure is unknown)
```

Time-remaining is a **fallback**, not the primary trigger.

## 7. Requests are not uniform

Requests are classified by meaning, not all funneled into "next-next." Summary
(full detail in [`request-semantics.md`](request-semantics.md)):

| Utterance | Effect |
| --------- | ------ |
| "play this track" | append after `committedNextTrack` (into the provisional queue) |
| "play this next" | attempt to **replace** `committedNextTrack` |
| "stop now" / skip | immediate control path (not the queue) |
| "a bit faster" | multi-track **selection policy** |
| "don't play this genre" | continuous **exclusion constraint** |
| "next 3 tracks calm" | **expiring (TTL) policy** |

## 8. Scope — hackathon vs ideal

**Ideal:** a request may not be satisfiable at the immediate next slot. Bridging BPM 60
to BPM 160 needs intermediate steps (70, 80, 90 …) — humans cannot follow abrupt tempo
jumps, and straying too far from the current track is jarring even with tempo-sync. So
a request can legitimately land several tracks out, and the Planner may insert bridge
selections.

**Hackathon scope (current target):** this bridging is **out of scope**. Adding a
request to the provisional queue is sufficient. Record the ideal here so the model is
not mistaken for the final ambition, but do not implement bridge planning now.

## 9. Implementation order (canonical)

0. **This spec + the state machine** — canon in the repo (done when these docs exist).
1. Make the **Conductor state machine explicit**
   ([`conductor-state-machine.md`](conductor-state-machine.md)).
2. **Early-commit** the next track: select → load → CUE → transition-plan → wait
   (not merely "load earlier").
3. **Structure-based** firing condition (§6 priority; time-remaining demoted to
   fallback).
4. **Provisional queue + request reflection** (§7, three-tier state of §3).

No new large abstraction framework is required. Equally, merely adding timer
conditions to the existing reactive loop is **not acceptable**. Update README /
submission text / demo steps **in parallel** — this is not "feature work OR
submission."

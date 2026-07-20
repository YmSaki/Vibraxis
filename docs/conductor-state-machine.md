# Conductor state machine — canonical spec

Status: **authoritative**. Companion to [`autonomous-dj-model.md`](autonomous-dj-model.md)
(the model) and [`request-semantics.md`](request-semantics.md) (input meaning). This
file fixes the Conductor's states so the implementation is a state machine, not a
timer bolted onto a reactive loop.

## 1. Planner vs Executor

Two responsibilities, deliberately separated (model §4):

- **Planner** — owns *what next* and *how to transition*. Produces a fully-prepared
  `committedNextTrack` (a track id **plus** a transition plan, model §5) ahead of the
  firing moment, and maintains `provisionalQueue`.
- **Executor** — owns the decks and the clock. Prepares the target deck, watches for
  the musical firing condition, executes the beat-matched transition, then promotes
  and asks the Planner to plan again.

Pipeline:

```
selection plan → transition plan → deck preparation → transition-condition monitor → execute → plan update
[------------ Planner ------------]  [--------------------- Executor ---------------------]  [ Planner ]
```

## 2. States

```
PLAYING_CURRENT
    │  Planner has (or is asked for) the next track
    ▼
PLANNING_NEXT        Planner selects committedNextTrack + builds its transition plan
    │
    ▼
PREPARING_NEXT       Executor loads the target deck, sets CUE, tempo-syncs, pre-rolls
    │
    ▼
NEXT_READY           target deck prepared and idle; transition plan finalized
    │
    ▼
TRANSITION_ARMED     Executor monitors the firing condition (section/phrase/bar; time fallback)
    │  firing condition met
    ▼
TRANSITIONING        beat-matched blend runs (no per-mix approval — model invariant 5)
    │  blend complete
    ▼
PROMOTE_NEXT         committedNextTrack → currentTrack; old deck released
    │
    ▼
PLANNING_NEXT        (loop) promote provisionalQueue[0] toward the next commit
```

Normal operation is the loop `PLANNING_NEXT → … → PROMOTE_NEXT → PLANNING_NEXT`,
running endlessly with no user confirmation.

## 3. Failure / degraded states

Every planning or preparation step can fail; the machine must name them rather than
silently stalling (model invariant 7 — the user is notified only on failure):

```
NO_CANDIDATE          selection produced no eligible track (exclusions/limits too tight)
LOAD_FAILED           target deck load failed (missing audio, decode error)
ANALYSIS_INCOMPLETE   no usable beat grid / sections to plan or fire against
TRANSITION_ABORTED    firing/executing failed or was pre-empted (override, PANIC, anomaly)
```

Handling:

- `NO_CANDIDATE` / `ANALYSIS_INCOMPLETE` — stay in `PLAYING_CURRENT`; surface the
  reason; keep re-planning as policy/queue changes (do not fabricate a pick).
- `LOAD_FAILED` — drop that candidate, re-plan from the provisional queue.
- `TRANSITION_ABORTED` — yield to the user/safety cause; the current track keeps
  playing; re-arm only when state is stable again (never overwrite a user override —
  AGENTS.md §0.3/§0.5).

## 4. Interrupts (cut across states)

These are not part of the normal loop; they pre-empt it:

- **PANIC** — hard stop of all audio, from any state.
- **Immediate skip** — force-advance now, allowed to cut a protected section
  (model §6).
- **"Play this next"** — request to replace `committedNextTrack`; honored if the
  machine has not yet passed the point where the current commit is irreversibly
  firing (`TRANSITIONING`); otherwise it lands in the provisional queue.
- **Playback anomaly** (silence/corruption) — force `TRANSITION_ABORTED` or an
  emergency advance.

## 5. What this deliberately is NOT

- Not a single `setInterval` that decides + loads at `remaining < N` seconds. That is
  the reactive loop being replaced.
- Not a promise to fully commit the next-next track (model §3 — next-next stays
  provisional).
- Not a large new framework — a small explicit state machine over the existing,
  tested selection + transition primitives.

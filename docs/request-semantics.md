# Request semantics — canonical spec

Status: **authoritative**. Companion to [`autonomous-dj-model.md`](autonomous-dj-model.md)
and [`conductor-state-machine.md`](conductor-state-machine.md). Defines how user input is
classified and where each class takes effect. A request is never a per-mix approval
(model invariant 5) and, by default, is not an immediate-play command (invariant 3).

## 1. Classification

Input is classified by meaning; it is **not** uniformly appended as "the next-next
track."

| Class | Example | Target | Persistence |
| ----- | ------- | ------ | ----------- |
| Track request | "play this track" | append into `provisionalQueue` (after `committedNextTrack`) | one-shot |
| Next-swap | "play this **next**" | attempt to **replace** `committedNextTrack` (else fall back to queue) | one-shot |
| Selection policy | "a bit faster", "keep it moody" | selection-score bias over **many** tracks | persistent until changed |
| Exclusion | "don't play this genre / this track" | continuous exclusion constraint on selection | persistent until lifted |
| Expiring policy | "next 3 tracks calm", "chill for 10 minutes" | policy with a **TTL** (track-count or time) | until it expires |
| Immediate control | "stop now", skip, PANIC | control path — **not** the queue | instantaneous |

## 2. Default rule

When intent is ambiguous or a plain track is named, default to a **track request**
into `provisionalQueue` — i.e. the reflected effect is "later," not "now." This keeps
the autonomous set flowing and honors invariants 2–3.

## 3. Next-swap constraints

"Play this next" tries to replace `committedNextTrack`. It is honored only while the
Conductor has not begun the irreversible firing of the current commit (state ≤
`TRANSITION_ARMED`; see the state machine). Past that point (`TRANSITIONING`), the
request degrades to a track request at the head of `provisionalQueue`, and the user is
told it will play after the current transition.

## 4. Policies compose with selection, not with the queue

Selection policies, exclusions, and expiring policies do **not** insert specific
tracks. They change the *scoring/constraints* the Planner uses when it fills
`committedNextTrack` and `provisionalQueue`. This is why "a bit faster" affects several
upcoming tracks rather than picking one — model §7.

## 5. Rejection & notification (invariant 7)

A request is honored silently (it just shapes the queue/policy — the user sees the
updated state, not a confirmation). The user is **notified only when a request cannot
be executed**, e.g.:

- named track does not exist / is not in the crate,
- named track is unplayable (missing audio, `ANALYSIS_INCOMPLETE`),
- the request contradicts a hard constraint (e.g. excluded genre + explicit request
  for that genre),
- no eligible candidate remains under the combined constraints (`NO_CANDIDATE`).

The notification states the reason; it never asks the user to approve a track.

## 6. Scope — hackathon vs ideal

**Ideal:** a request may not fit at the immediate next slot. Bridging a large BPM gap
(60 → 160) needs intermediate selections (70, 80, 90 …) so the tempo climb is natural;
straying too far from the current track is jarring even with tempo-sync. The Planner
would then land the request several tracks out and insert bridge picks.

**Hackathon scope (current target):** bridging is **out of scope**. Classifying the
request and placing it in `provisionalQueue` (or as a policy) is sufficient. The ideal
is recorded so the model is not mistaken for the final ambition — do not implement
bridge planning now.

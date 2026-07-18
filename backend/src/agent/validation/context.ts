/**
 * Structural validation of the DjContext that crosses the boundary. The context
 * is assembled by the application (not by an AI), but it still arrives as JSON,
 * so we verify its shape before any provider runs. Malformed context is rejected
 * with a reason; it is never repaired.
 *
 * The deterministic engine (`selectNextTrack`) performs its own thorough
 * validation and throws on malformed input; this function gives the codex-local
 * path — which does not call the engine first — the same up-front guarantee, and
 * yields a typed failure instead of a thrown error.
 */

import type { DjContext, DjTrackSummary } from "@vibraxis/shared/dj";

export type ContextValidation =
  | { ok: true }
  | { ok: false; detail: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function findUnexpectedKey(value: object, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key)) ?? null;
}

function validateTrack(path: string, t: unknown): string | null {
  if (typeof t !== "object" || t === null) return `${path} must be an object`;
  const unexpectedKey = findUnexpectedKey(t, [
    "trackId",
    "title",
    "artist",
    "genre",
    "mood",
    "bpm",
    "camelot",
    "energy",
    "hasBeatGrid",
    "hasSectionCues",
  ]);
  if (unexpectedKey !== null) return `${path} contains unexpected field: ${unexpectedKey}`;
  const track = t as Partial<DjTrackSummary>;
  if (typeof track.trackId !== "string" || track.trackId.length === 0) {
    return `${path}.trackId must be a non-empty string`;
  }
  if (track.trackId.length > 200) return `${path}.trackId must be at most 200 characters`;
  if (typeof track.title !== "string" || track.title.length === 0 || track.title.length > 300) {
    return `${path}.title must be a non-empty string of at most 300 characters`;
  }
  if (typeof track.artist !== "string" || track.artist.length === 0 || track.artist.length > 300) {
    return `${path}.artist must be a non-empty string of at most 300 characters`;
  }
  if (typeof track.camelot !== "string" || track.camelot.length === 0) {
    return `${path}.camelot must be a non-empty string`;
  }
  if (track.camelot.length > 32) return `${path}.camelot must be at most 32 characters`;
  if (typeof track.genre !== "string" || track.genre.length === 0 || track.genre.length > 80) {
    return `${path}.genre must be a non-empty string of at most 80 characters`;
  }
  if (!Array.isArray(track.mood) || track.mood.length > 32) {
    return `${path}.mood must be an array of at most 32 strings`;
  }
  if (track.mood.some((m) => typeof m !== "string" || m.length === 0 || m.length > 80)) {
    return `${path}.mood items must be non-empty strings of at most 80 characters`;
  }
  if (!isFiniteNumber(track.bpm)) return `${path}.bpm must be a finite number`;
  if (!isFiniteNumber(track.energy) || track.energy < 0 || track.energy > 1) {
    return `${path}.energy must be a finite number in [0, 1]`;
  }
  if (typeof track.hasBeatGrid !== "boolean") {
    return `${path}.hasBeatGrid must be a boolean`;
  }
  if (typeof track.hasSectionCues !== "boolean") {
    return `${path}.hasSectionCues must be a boolean`;
  }
  return null;
}

export function validateContext(context: unknown): ContextValidation {
  if (typeof context !== "object" || context === null) {
    return { ok: false, detail: "context must be an object" };
  }
  const c = context as Partial<DjContext>;
  const unexpectedContextKey = findUnexpectedKey(context, [
    "activeDeckId",
    "inactiveDeckId",
    "currentTrack",
    "candidates",
    "recentlyPlayedTrackIds",
    "limits",
  ]);
  if (unexpectedContextKey !== null) {
    return { ok: false, detail: `context contains unexpected field: ${unexpectedContextKey}` };
  }

  if (c.activeDeckId !== "A" && c.activeDeckId !== "B") {
    return { ok: false, detail: "context.activeDeckId must be 'A' or 'B'" };
  }
  if (c.inactiveDeckId !== "A" && c.inactiveDeckId !== "B") {
    return { ok: false, detail: "context.inactiveDeckId must be 'A' or 'B'" };
  }
  if (c.activeDeckId === c.inactiveDeckId) {
    return { ok: false, detail: "activeDeckId and inactiveDeckId must differ" };
  }

  const currentErr = validateTrack("context.currentTrack", c.currentTrack);
  if (currentErr !== null) return { ok: false, detail: currentErr };

  if (!Array.isArray(c.candidates)) {
    return { ok: false, detail: "context.candidates must be an array" };
  }
  for (let i = 0; i < c.candidates.length; i += 1) {
    const err = validateTrack(`context.candidates[${i}]`, c.candidates[i]);
    if (err !== null) return { ok: false, detail: err };
  }
  const ids = c.candidates.map((t) => (t as DjTrackSummary).trackId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, detail: "context.candidates trackId values must be unique" };
  }

  if (!Array.isArray(c.recentlyPlayedTrackIds)) {
    return { ok: false, detail: "context.recentlyPlayedTrackIds must be an array" };
  }
  if (c.recentlyPlayedTrackIds.length > 1000 || c.recentlyPlayedTrackIds.some(
    (id) => typeof id !== "string" || id.length === 0 || id.length > 200,
  )) {
    return { ok: false, detail: "context.recentlyPlayedTrackIds must contain at most 1000 non-empty strings of at most 200 characters" };
  }

  const limits = c.limits;
  if (typeof limits !== "object" || limits === null) {
    return { ok: false, detail: "context.limits must be an object" };
  }
  const unexpectedLimitsKey = findUnexpectedKey(limits, [
    "minPlaybackRate",
    "maxPlaybackRate",
    "allowedCrossfadeBars",
  ]);
  if (unexpectedLimitsKey !== null) {
    return { ok: false, detail: `context.limits contains unexpected field: ${unexpectedLimitsKey}` };
  }
  if (!isFiniteNumber(limits.minPlaybackRate) || !isFiniteNumber(limits.maxPlaybackRate)) {
    return { ok: false, detail: "limits.min/maxPlaybackRate must be finite numbers" };
  }
  if (limits.minPlaybackRate <= 0 || limits.maxPlaybackRate < limits.minPlaybackRate) {
    return { ok: false, detail: "limits requires 0 < minPlaybackRate <= maxPlaybackRate" };
  }
  if (!Array.isArray(limits.allowedCrossfadeBars)) {
    return { ok: false, detail: "limits.allowedCrossfadeBars must be an array" };
  }
  for (let i = 0; i < limits.allowedCrossfadeBars.length; i += 1) {
    const bars = limits.allowedCrossfadeBars[i];
    if (!isFiniteNumber(bars) || !Number.isInteger(bars) || bars <= 0) {
      return {
        ok: false,
        detail: `limits.allowedCrossfadeBars[${i}] must be a positive integer`,
      };
    }
  }

  return { ok: true };
}

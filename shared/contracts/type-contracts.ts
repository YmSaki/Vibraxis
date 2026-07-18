import type { AnalysisCapabilities } from "../analysis/index.js";
import type {
  DjDecision,
  DjExclusionCode,
  DjIntent,
  DjNoCandidateCode,
  DjSelectionResult,
} from "../dj/index.js";
import {
  DJ_EXCLUSION_CODES,
  DJ_NO_CANDIDATE_CODES,
} from "../dj/index.js";
import type {
  DeckEqState,
  DeckLoadRequest,
  DeckSetEqParams,
  MixerP0When,
  MixerState,
  RampCrossfaderParams,
} from "../vdap/index.js";

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type Same<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type ExpectedDjDecision = {
  nextTrackId: string;
  targetDeckId: "A" | "B";
  tempoSync: "none" | "tempo";
  startAt: "nextBar";
  crossfadeBars: number;
  confidence: number;
  reasons: string[];
};

type ExpectedDjIntent = {
  energyDirection: "decrease" | "maintain" | "increase";
  targetEnergy: number | null;
  preferredGenres: string[];
  avoidedGenres: string[];
  preferredMoods: string[];
  avoidedMoods: string[];
  tempoDirection: "slower" | "similar" | "faster" | "any";
  harmonicPriority: "strict" | "compatible" | "ignore";
  transitionUrgency: "quick" | "normal" | "gradual";
  requestedTrackId: string | null;
  excludedTrackIds: string[];
  rationale: string;
  confidence: number;
};

type _DjDecisionContractIsPinned = Assert<Same<DjDecision, ExpectedDjDecision>>;
type _DjIntentContractIsPinned = Assert<Same<DjIntent, ExpectedDjIntent>>;

// The deterministic order-5 result is a discriminated union: a validated
// DjDecision OR an explicit no-candidate outcome. Both variants carry ranked
// diagnostics, so a caller can always inspect inclusion scores and exclusions.
type _SelectionStatusIsClosed = Assert<
  Same<DjSelectionResult["status"], "selected" | "noCandidate">
>;
type _SelectedVariantCarriesDecision = Assert<
  Extract<DjSelectionResult, { status: "selected" }>["decision"] extends DjDecision
    ? true
    : false
>;
type _NoCandidateVariantHasNoDecision = AssertFalse<
  "decision" extends keyof Extract<DjSelectionResult, { status: "noCandidate" }>
    ? true
    : false
>;

// The machine-readable code enumerations are the runtime source of truth for the
// exported string-literal types.
type _ExclusionCodesMatchConst = Assert<
  Same<DjExclusionCode, (typeof DJ_EXCLUSION_CODES)[number]>
>;
type _NoCandidateCodesMatchConst = Assert<
  Same<DjNoCandidateCode, (typeof DJ_NO_CANDIDATE_CODES)[number]>
>;

type _SecondsRampMayOmitReference = Assert<
  { duration: { seconds: 4 }; to: 1; curve: "equalPower" } extends RampCrossfaderParams
    ? true
    : false
>;

type _BarsRampMustHaveReference = AssertFalse<
  { duration: { bars: 2 }; to: 1; curve: "equalPower" } extends RampCrossfaderParams
    ? true
    : false
>;

type _RampDurationMustHaveExactlyOneUnit = AssertFalse<
  {
    duration: { bars: 2; seconds: 4 };
    referenceDeckId: "A";
    to: 1;
    curve: "equalPower";
  } extends RampCrossfaderParams
    ? true
    : false
>;

type _RampDoesNotAcceptDjCurve = AssertFalse<
  { duration: { seconds: 4 }; to: 1; curve: "dj" } extends RampCrossfaderParams
    ? true
    : false
>;

type _MusicalMixerWhenMustHaveDeck = AssertFalse<
  { at: "nextBar" } extends MixerP0When ? true : false
>;

type _ImmediateMixerWhenNeedsNoDeck = Assert<
  { at: "immediate" } extends MixerP0When ? true : false
>;

type _DeckEqStateIsPinned = Assert<
  Same<DeckEqState, { lowDb: number; midDb: number; highDb: number }>
>;

type _DeckSetEqParamsArePinned = Assert<
  Same<
    DeckSetEqParams,
    { deckId: "A" | "B"; band: "low" | "mid" | "high"; gainDb: number }
  >
>;

type _ManualCrossfaderSupportsDjCurve = Assert<
  "dj" extends MixerState["crossfader"]["curve"] ? true : false
>;

type _AnalysisCapabilitiesAreClosed = AssertFalse<
  string extends keyof AnalysisCapabilities ? true : false
>;

type LoadEnvelope = {
  vdap: "1.0";
  kind: "request";
  requestId: "load-1";
  command: "deck.load";
};

type _ReplacingLoadMustHaveBindingPrecondition = AssertFalse<
  (LoadEnvelope & {
    params: {
      deckId: "B";
      source: { kind: "catalog"; trackId: "track-2" };
      replacePlaying: true;
    };
  }) extends DeckLoadRequest
    ? true
    : false
>;

type _ReplacingLoadWithBindingIsAccepted = Assert<
  (LoadEnvelope & {
    expectedBindingId: "bind-1";
    params: {
      deckId: "B";
      source: { kind: "catalog"; trackId: "track-2" };
      replacePlaying: true;
    };
  }) extends DeckLoadRequest
    ? true
    : false
>;

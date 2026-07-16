import type { AnalysisCapabilities } from "../analysis/index.js";
import type {
  DeckLoadRequest,
  MixerP0When,
  RampCrossfaderParams,
} from "../vdap/index.js";

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;

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

type _MusicalMixerWhenMustHaveDeck = AssertFalse<
  { at: "nextBar" } extends MixerP0When ? true : false
>;

type _ImmediateMixerWhenNeedsNoDeck = Assert<
  { at: "immediate" } extends MixerP0When ? true : false
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

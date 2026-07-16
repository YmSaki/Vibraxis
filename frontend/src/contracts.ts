/**
 * Frontend-facing entry point for contracts shared with the future backend and
 * DJ providers. Keep runtime state and provider output types sourced from the
 * shared workspace instead of redefining them in React components.
 */
export type {
  RuntimeAnalysisInput,
  TrackAnalysis,
} from "@vibraxis/shared/analysis";
export type {
  DeckState,
  MixerState,
  RuntimeState,
  TrackBinding,
  VdapAck,
  VdapEvent,
  VdapRequest,
  VdapSnapshot,
} from "@vibraxis/shared/vdap";
export type {
  DjContext,
  DjDecision,
  DjIntent,
  TransitionPlan,
} from "@vibraxis/shared/dj";

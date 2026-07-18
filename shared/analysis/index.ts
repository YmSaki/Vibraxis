import analysisSchema from "../../analyze-tool/analysis.schema.json" with {
  type: "json",
};

export * from "./timeline";

/**
 * The runtime schema remains owned by analyze-tool. This export intentionally
 * points at that file instead of maintaining a second schema under shared/.
 */
export { analysisSchema };

export type AnalysisSchemaVersion = 2;
export type AnalysisScale = "major" | "minor";
export type TempoAdjustment = "none" | "double" | "half" | "clamp";
export type AnalysisCapabilityStatus =
  | "complete"
  | "partial"
  | "failed"
  | "skipped";

export interface AnalysisSource {
  file: string;
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
}

export interface AnalyzerInfo {
  provider: string;
  version: string;
  analyzedAt: string;
  configHash: string;
}

export interface AnalysisCapability {
  status: AnalysisCapabilityStatus;
  provider: string;
  version: string;
  confidence: number | null;
  error: string | null;
}

export interface AnalysisCapabilities {
  features: AnalysisCapability;
  beatGrid: AnalysisCapability;
  harmony: AnalysisCapability;
  structure: AnalysisCapability;
}

export interface TempoAnalysis {
  bpm: number;
  rawBpm: number;
  adjustment: TempoAdjustment;
  timeSignature: string;
  beatsSeconds: readonly number[];
  downbeatsSeconds: readonly number[];
  barsSeconds: readonly number[];
}

export interface KeyRegion {
  startSeconds: number;
  endSeconds: number;
  key: string;
  scale: AnalysisScale;
  confidence: number;
}

export interface TonalAnalysis {
  key: string;
  scale: AnalysisScale;
  camelot: string;
  confidence: number;
  keyRegions: readonly KeyRegion[];
}

export interface ChordAnalysis {
  rawStartSeconds: number;
  rawEndSeconds: number;
  startSeconds: number;
  endSeconds: number;
  beatIndex: number;
  barIndex: number;
  symbol: string;
  root: string | null;
  quality: string;
  bass: string | null;
  localKey: string;
  degree: string;
  confidence: number;
}

export interface HarmonyAnalysis {
  chords: readonly ChordAnalysis[];
}

export type SectionLabel =
  | "intro"
  | "verse"
  | "preChorus"
  | "chorus"
  | "build"
  | "drop"
  | "breakdown"
  | "bridge"
  | "instrumental"
  | "outro"
  | "other";

export interface AnalysisSection {
  startSeconds: number;
  endSeconds: number;
  startBeat: number;
  endBeat: number;
  startBar: number;
  endBar: number;
  label: SectionLabel;
  rawLabel: string;
  confidence: number;
  energy: number;
}

export interface AnalysisPhrase {
  startSeconds: number;
  endSeconds: number;
  startBar: number;
  endBar: number;
  sectionIndex: number;
}

export interface StructureAnalysis {
  sections: readonly AnalysisSection[];
  phrases: readonly AnalysisPhrase[];
}

export interface AudioFeatures {
  energy: number;
  rms: number;
  loudnessDb: number;
  dynamicRangeDb: number;
  onsetRate: number;
  spectralCentroidHz: number;
}

/** Static view of a record validated by analyze-tool/analysis.schema.json. */
export interface TrackAnalysis {
  schemaVersion: AnalysisSchemaVersion;
  trackId: string;
  source: AnalysisSource;
  analyzer: AnalyzerInfo;
  capabilities: AnalysisCapabilities;
  tempo: TempoAnalysis;
  tonal: TonalAnalysis;
  harmony: HarmonyAnalysis;
  structure: StructureAnalysis;
  features: AudioFeatures;
  overridesApplied: readonly string[];
}

/** Minimal beat/downbeat/section projection consumed by the VDAP runtime. */
export interface RuntimeAnalysisInput {
  trackId: string;
  durationSeconds: number;
  bpm: number;
  timeSignature: string;
  beatsSeconds: readonly number[];
  downbeatsSeconds: readonly number[];
  barsSeconds: readonly number[];
  sections: readonly AnalysisSection[];
}

export function toRuntimeAnalysisInput(
  analysis: TrackAnalysis,
): RuntimeAnalysisInput {
  return {
    trackId: analysis.trackId,
    durationSeconds: analysis.source.durationSeconds,
    bpm: analysis.tempo.bpm,
    timeSignature: analysis.tempo.timeSignature,
    beatsSeconds: analysis.tempo.beatsSeconds,
    downbeatsSeconds: analysis.tempo.downbeatsSeconds,
    barsSeconds: analysis.tempo.barsSeconds,
    sections: analysis.structure.sections,
  };
}

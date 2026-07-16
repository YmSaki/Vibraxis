from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


Scale = Literal["major", "minor"]
TempoAdjustment = Literal["none", "double", "half", "clamp"]
CapabilityState = Literal["complete", "partial", "failed", "skipped"]


def _unit_interval(name: str, value: float) -> None:
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {value}")


def _ordered(name: str, values: list[float], *, strict: bool = True) -> None:
    if any(value < 0 for value in values):
        raise ValueError(f"{name} timestamps cannot be negative")
    pairs = zip(values, values[1:])
    if any(left >= right if strict else left > right for left, right in pairs):
        raise ValueError(f"{name} timestamps must be strictly increasing")


@dataclass(frozen=True)
class SourceInfo:
    file: str
    sha256: str
    duration_seconds: float
    sample_rate: int

    def __post_init__(self) -> None:
        if not self.file:
            raise ValueError("source file must not be empty")
        if len(self.sha256) != 64:
            raise ValueError("sha256 must contain 64 hexadecimal characters")
        int(self.sha256, 16)
        if self.duration_seconds <= 0 or self.sample_rate <= 0:
            raise ValueError("source duration and sample rate must be positive")


@dataclass(frozen=True)
class AnalyzerInfo:
    provider: str
    version: str
    analyzed_at: str
    config_hash: str


@dataclass(frozen=True)
class CapabilityInfo:
    status: CapabilityState
    provider: str
    version: str
    confidence: float | None = None
    error: str | None = None

    def __post_init__(self) -> None:
        if self.confidence is not None:
            _unit_interval("capability confidence", self.confidence)
        if self.status == "failed" and not self.error:
            raise ValueError("failed capability must include an error")


@dataclass(frozen=True)
class TempoInfo:
    bpm: float
    raw_bpm: float
    adjustment: TempoAdjustment
    time_signature: str = "4/4"
    beats_seconds: list[float] = field(default_factory=list)
    downbeats_seconds: list[float] = field(default_factory=list)
    bars_seconds: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.bpm <= 0 or self.raw_bpm <= 0:
            raise ValueError("tempo values must be positive")
        _ordered("beat", self.beats_seconds)
        _ordered("downbeat", self.downbeats_seconds)
        _ordered("bar", self.bars_seconds)


@dataclass(frozen=True)
class KeyRegion:
    start_seconds: float
    end_seconds: float
    key: str
    scale: Scale
    confidence: float

    def __post_init__(self) -> None:
        if self.start_seconds < 0 or self.end_seconds <= self.start_seconds:
            raise ValueError("key region must have a positive duration")
        _unit_interval("key region confidence", self.confidence)


@dataclass(frozen=True)
class TonalInfo:
    key: str
    scale: Scale
    camelot: str
    confidence: float
    key_regions: list[KeyRegion] = field(default_factory=list)

    def __post_init__(self) -> None:
        _unit_interval("tonal confidence", self.confidence)
        _validate_intervals("key regions", self.key_regions)


@dataclass(frozen=True)
class ChordEvent:
    raw_start_seconds: float
    raw_end_seconds: float
    start_seconds: float
    end_seconds: float
    beat_index: int
    bar_index: int
    symbol: str
    root: str | None
    quality: str
    bass: str | None
    local_key: str
    degree: str
    confidence: float

    def __post_init__(self) -> None:
        if self.start_seconds < 0 or self.end_seconds <= self.start_seconds:
            raise ValueError("chord must have a positive duration")
        if self.raw_start_seconds < 0 or self.raw_end_seconds <= self.raw_start_seconds:
            raise ValueError("raw chord must have a positive duration")
        if self.beat_index < 0 or self.bar_index < 0:
            raise ValueError("chord indexes cannot be negative")
        _unit_interval("chord confidence", self.confidence)


@dataclass(frozen=True)
class HarmonyInfo:
    chords: list[ChordEvent] = field(default_factory=list)

    def __post_init__(self) -> None:
        _validate_intervals("chords", self.chords)


SectionLabel = Literal[
    "intro", "verse", "preChorus", "chorus", "build", "drop",
    "breakdown", "bridge", "instrumental", "outro", "other",
]


@dataclass(frozen=True)
class Section:
    start_seconds: float
    end_seconds: float
    start_beat: int
    end_beat: int
    start_bar: int
    end_bar: int
    label: SectionLabel
    raw_label: str
    confidence: float
    energy: float

    def __post_init__(self) -> None:
        if self.start_seconds < 0 or self.end_seconds <= self.start_seconds:
            raise ValueError("section must have a positive duration")
        if min(self.start_beat, self.end_beat, self.start_bar, self.end_bar) < 0:
            raise ValueError("section indexes cannot be negative")
        _unit_interval("section confidence", self.confidence)
        _unit_interval("section energy", self.energy)


@dataclass(frozen=True)
class Phrase:
    start_seconds: float
    end_seconds: float
    start_bar: int
    end_bar: int
    section_index: int

    def __post_init__(self) -> None:
        if self.start_seconds < 0 or self.end_seconds <= self.start_seconds:
            raise ValueError("phrase must have a positive duration")
        if min(self.start_bar, self.end_bar, self.section_index) < 0:
            raise ValueError("phrase indexes cannot be negative")


@dataclass(frozen=True)
class StructureInfo:
    sections: list[Section] = field(default_factory=list)
    phrases: list[Phrase] = field(default_factory=list)

    def __post_init__(self) -> None:
        _validate_intervals("sections", self.sections)
        _validate_intervals("phrases", self.phrases)


@dataclass(frozen=True)
class AudioFeatures:
    energy: float
    rms: float
    loudness_db: float
    dynamic_range_db: float
    onset_rate: float
    spectral_centroid_hz: float

    def __post_init__(self) -> None:
        _unit_interval("energy", self.energy)
        if self.rms < 0 or self.dynamic_range_db < 0 or self.onset_rate < 0:
            raise ValueError("audio features cannot be negative, except loudness_db")
        if self.spectral_centroid_hz < 0:
            raise ValueError("spectral_centroid_hz cannot be negative")


@dataclass(frozen=True)
class AnalysisRecord:
    track_id: str
    source: SourceInfo
    analyzer: AnalyzerInfo
    capabilities: dict[str, CapabilityInfo]
    tempo: TempoInfo
    tonal: TonalInfo
    harmony: HarmonyInfo
    structure: StructureInfo
    features: AudioFeatures
    schema_version: int = 2
    overrides_applied: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.schema_version != 2:
            raise ValueError("unsupported schema version")
        if not self.track_id:
            raise ValueError("track_id must not be empty")
        required = {"features", "beatGrid", "harmony", "structure"}
        if set(self.capabilities) != required:
            raise ValueError(f"capabilities must contain exactly {sorted(required)}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "trackId": self.track_id,
            "source": _camel(asdict(self.source)),
            "analyzer": _camel(asdict(self.analyzer)),
            "capabilities": {key: _camel(asdict(value)) for key, value in self.capabilities.items()},
            "tempo": _camel(asdict(self.tempo)),
            "tonal": _camel(asdict(self.tonal)),
            "harmony": _camel(asdict(self.harmony)),
            "structure": _camel(asdict(self.structure)),
            "features": _camel(asdict(self.features)),
            "overridesApplied": self.overrides_applied,
        }


def _validate_intervals(name: str, values: list[Any]) -> None:
    for left, right in zip(values, values[1:]):
        if left.end_seconds > right.start_seconds + 1e-6:
            raise ValueError(f"{name} must not overlap")


def _camel(value: Any) -> Any:
    if isinstance(value, dict):
        return {_camel_key(key): _camel(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_camel(item) for item in value]
    return value


def _camel_key(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)

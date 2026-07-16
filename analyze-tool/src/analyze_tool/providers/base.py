from __future__ import annotations

from pathlib import Path
from typing import Protocol

from analyze_tool.models import AnalysisRecord, AudioFeatures, HarmonyInfo, StructureInfo, TempoInfo


class AudioAnalyzer(Protocol):
    name: str
    version: str
    config_hash: str

    def analyze(
        self,
        path: Path,
        *,
        source_name: str | None = None,
        bpm_override: float | None = None,
    ) -> AnalysisRecord: ...


class HarmonyProvider(Protocol):
    name: str
    version: str

    def analyze_harmony(self, path: Path) -> HarmonyInfo: ...


class FeatureProvider(Protocol):
    name: str
    version: str

    def analyze_features(self, path: Path) -> AudioFeatures: ...


class BeatGridProvider(Protocol):
    name: str
    version: str

    def analyze_beat_grid(self, path: Path) -> TempoInfo: ...


class StructureProvider(Protocol):
    name: str
    version: str

    def analyze_structure(self, path: Path) -> StructureInfo: ...

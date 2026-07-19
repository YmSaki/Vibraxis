from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, Sequence

from analyze_tool.overrides import apply_overrides
from analyze_tool.catalog import build_catalog
from analyze_tool.validation import validate_analysis
from analyze_tool.providers.librosa_provider import LibrosaAnalyzer

OVERRIDE_PROCESSOR_VERSION = 2


SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vibraxis-analyze",
        description="Analyze local audio into committed Vibraxis catalog metadata.",
    )
    parser.add_argument("input", type=Path, help="Audio file or directory to analyze")
    parser.add_argument(
        "--output",
        type=Path,
        default=REPOSITORY_ROOT / "data" / "analysis",
        help="Output directory (default: repository data/analysis)",
    )
    parser.add_argument(
        "--overrides",
        type=Path,
        default=REPOSITORY_ROOT / "analyze-tool" / "overrides.json",
        help="Manual override JSON file",
    )
    parser.add_argument("--min-bpm", type=float, default=70.0)
    parser.add_argument("--max-bpm", type=float, default=180.0)
    parser.add_argument("--profile", choices=("baseline", "full"), default="full")
    parser.add_argument(
        "--require-complete", action="store_true",
        help="Fail when any analysis capability is not complete",
    )
    parser.add_argument("--allow-partial", action="store_true", help="Allow partial analysis in catalog output")
    parser.add_argument(
        "--allow-unverified-license", action="store_true",
        help="Allow explicitly marked unverified licenses in a development catalog",
    )
    parser.add_argument("--catalog-source", type=Path, help="Curated catalog-source.json")
    parser.add_argument(
        "--catalog-output", type=Path,
        default=REPOSITORY_ROOT / "data" / "catalog.json",
    )
    parser.add_argument("--force", action="store_true", help="Ignore matching cached records")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        input_root = args.input.resolve()
        audio_files = discover_audio(input_root)
        ensure_unique_track_ids(audio_files)
        overrides = load_overrides(args.overrides)
        args.output.mkdir(parents=True, exist_ok=True)
        analyzer = LibrosaAnalyzer(min_bpm=args.min_bpm, max_bpm=args.max_bpm, profile=args.profile)

        analyzed = 0
        cached = 0
        failed = 0
        for path in audio_files:
            selected_overrides = overrides_for(path, overrides)
            config_hash = combined_config_hash(analyzer.config_hash, selected_overrides)
            output_path = args.output / f"{track_id_for(path)}.json"
            source_hash = sha256_file(path)
            if not args.force and cache_matches(
                output_path,
                source_hash=source_hash,
                analyzer_version=analyzer.version,
                config_hash=config_hash,
                require_complete=args.require_complete,
            ):
                print(f"cached   {path}")
                cached += 1
                continue

            try:
                source_name = path.name if input_root.is_file() else path.relative_to(input_root).as_posix()
                bpm_override = selected_overrides.get("bpm")
                record = analyzer.analyze(
                    path,
                    source_name=source_name,
                    bpm_override=float(bpm_override) if bpm_override is not None else None,
                    downbeat_offset_beats=selected_overrides.get("downbeatOffsetBeats"),
                )
                record = apply_overrides(record, selected_overrides)
                incomplete = [name for name, info in record.capabilities.items() if info.status != "complete"]
                if args.require_complete and incomplete:
                    raise ValueError(f"incomplete capabilities: {incomplete}")
                record = replace(
                    record,
                    analyzer=replace(record.analyzer, config_hash=config_hash),
                )
                payload = record.to_dict()
                validate_analysis(payload, require_complete=args.require_complete)
                temporary = output_path.with_suffix(output_path.suffix + ".tmp")
                temporary.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                    encoding="utf-8",
                )
                temporary.replace(output_path)
                print(f"analyzed {path} -> {output_path}")
                analyzed += 1
            except Exception as error:  # Keep a batch moving and summarize failures.
                print(f"failed   {path}: {error}", file=sys.stderr)
                failed += 1

        if args.catalog_source and failed == 0:
            build_catalog(
                args.catalog_source.resolve(), args.output.resolve(), args.catalog_output.resolve(),
                allow_partial=args.allow_partial,
                allow_unverified_license=args.allow_unverified_license,
            )
            print(f"catalog  -> {args.catalog_output}")
        print(f"done: {analyzed} analyzed, {cached} cached, {failed} failed")
        return 1 if failed else 0
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


def discover_audio(input_path: Path) -> list[Path]:
    input_path = input_path.resolve()
    if not input_path.exists():
        raise FileNotFoundError(input_path)
    if input_path.is_file():
        if input_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"unsupported audio extension: {input_path.suffix}")
        return [input_path]
    files = sorted(
        path for path in input_path.rglob("*") if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if not files:
        raise ValueError(f"no supported audio files found under {input_path}")
    return files


def load_overrides(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    tracks = data.get("tracks", data)
    if not isinstance(tracks, dict) or any(not isinstance(value, dict) for value in tracks.values()):
        raise ValueError("overrides must be an object mapping filenames or track IDs to objects")
    return tracks


def ensure_unique_track_ids(paths: Sequence[Path]) -> None:
    seen: dict[str, Path] = {}
    for path in paths:
        track_id = track_id_for(path)
        if track_id in seen:
            raise ValueError(
                f"duplicate track ID '{track_id}' for {seen[track_id]} and {path}; rename one source file"
            )
        seen[track_id] = path


def overrides_for(path: Path, overrides: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return overrides.get(path.name, overrides.get(track_id_for(path), {}))


def track_id_for(path: Path) -> str:
    from analyze_tool.music import slugify_track_id

    return slugify_track_id(path)


def combined_config_hash(provider_hash: str, overrides: dict[str, Any]) -> str:
    payload = json.dumps(
        {
            "providerConfig": provider_hash,
            "overrideProcessorVersion": OVERRIDE_PROCESSOR_VERSION,
            "overrides": overrides,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cache_matches(
    path: Path, *, source_hash: str, analyzer_version: str, config_hash: str,
    require_complete: bool = False,
) -> bool:
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        validate_analysis(data, require_complete=require_complete)
        matches = (
            data["schemaVersion"] == 2
            and data["source"]["sha256"] == source_hash
            and data["analyzer"]["version"] == analyzer_version
            and data["analyzer"]["configHash"] == config_hash
        )
        return matches
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())

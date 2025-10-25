import argparse
import csv
import json
import logging
import os
import subprocess
os.environ.setdefault("TORCHAUDIO_USE_TORCHCODEC", "0")
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Sequence

ROOT_DIR = Path(__file__).resolve().parents[2]
WHISPER_DIR = ROOT_DIR / "whisper-diarization"
if str(WHISPER_DIR) not in sys.path:
    sys.path.insert(0, str(WHISPER_DIR))

import nltk
import torch
from ctc_forced_aligner import (
    generate_emissions,
    get_alignments,
    get_spans,
    load_alignment_model,
    postprocess_results,
    preprocess_text,
)
from deepmultilingualpunctuation import PunctuationModel
from diarization import MSDDDiarizer
from helpers import (
    cleanup,
    find_numeral_symbol_tokens,
    get_realigned_ws_mapping_with_punctuation,
    get_sentences_speaker_mapping,
    get_speaker_aware_transcript,
    get_words_speaker_mapping,
    langs_to_iso,
    process_language_arg,
    punct_model_langs,
    whisper_langs,
    write_srt,
)
from faster_whisper import BatchedInferencePipeline, WhisperModel, decode_audio


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Meeting Buddy diarization runner")
    parser.add_argument("--meeting", required=True, help="Meeting identifier")
    parser.add_argument("--audio", required=True, help="Path to the audio file")
    parser.add_argument("--out", required=True, help="Directory where outputs will be written")
    parser.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Execution device (cuda or cpu)",
    )
    parser.add_argument(
        "--whisper-model",
        dest="whisper_model",
        default=os.environ.get("DIARIZATION_WHISPER_MODEL", "medium.en"),
        help="Name of the Whisper model to use",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        dest="batch_size",
        default=int(os.environ.get("DIARIZATION_BATCH_SIZE", "8")),
        help="Batch size for batched inference (set to 0 for original Whisper long-form)",
    )
    parser.add_argument(
        "--language",
        type=str,
        choices=whisper_langs,
        default=None,
        help="Language code override (defaults to Whisper detection)",
    )
    parser.add_argument(
        "--no-stem",
        action="store_true",
        dest="no_stem",
        default=os.environ.get("DIARIZATION_DISABLE_STEM", "0") == "1",
        help="Disable Demucs vocal separation",
    )
    parser.add_argument(
        "--suppress-numerals",
        action="store_true",
        dest="suppress_numerals",
        default=False,
        help="Convert spoken numbers to text to improve alignment",
    )
    parser.add_argument(
        "--min-speakers",
        type=int,
        dest="min_speakers",
        default=None,
        help="Minimum number of speakers expected",
    )
    parser.add_argument(
        "--max-speakers",
        type=int,
        dest="max_speakers",
        default=None,
        help="Maximum number of speakers expected",
    )
    parser.add_argument(
        "--log-level",
        dest="log_level",
        default=os.environ.get("DIARIZATION_LOG_LEVEL", "INFO"),
        help="Logging level (DEBUG, INFO, WARNING, ERROR)",
    )
    return parser


def ensure_nltk_resources() -> None:
    try:
        nltk.data.find("tokenizers/punkt")
    except LookupError:  # pragma: no cover - external download
        nltk.download("punkt", quiet=True)
    for resource in ("punkt_tab", "averaged_perceptron_tagger"):  # optional extras
        try:
            nltk.data.find(f"tokenizers/{resource}")
        except LookupError:  # pragma: no cover - optional download
            try:
                nltk.download(resource, quiet=True)
            except Exception:  # pragma: no cover - best effort
                pass


def compute_device(requested: str) -> str:
    normalized = requested.lower()
    if normalized.startswith("cuda") and not torch.cuda.is_available():
        logging.warning("CUDA requested but not available; falling back to CPU")
        return "cpu"
    if normalized in {"cuda", "cpu"}:
        return normalized
    if normalized.startswith("cuda"):
        return normalized  # allow cuda:0 style
    return "cpu"


def compute_type_for_device(device: str) -> str:
    return "float16" if device.startswith("cuda") else "int8"


def maybe_separate_vocals(audio_path: Path, device: str, temp_root: Path, disable: bool) -> Path:
    if disable:
        logging.info("Skipping vocal separation (disabled via flag)")
        return audio_path

    logging.info("Demucs separation disabled by default; using original audio")
    return audio_path


def run_whisper_transcription(
    audio_waveform,
    language_code: str,
    whisper_model_name: str,
    device: str,
    batch_size: int,
    suppress_numerals: bool,
):
    whisper_model = WhisperModel(
        whisper_model_name,
        device=device,
        compute_type=compute_type_for_device(device),
    )
    pipeline = BatchedInferencePipeline(whisper_model)

    suppress_tokens = (
        find_numeral_symbol_tokens(whisper_model.hf_tokenizer)
        if suppress_numerals
        else [-1]
    )

    if batch_size > 0:
        segment_iter, info = pipeline.transcribe(
            audio_waveform,
            language_code,
            suppress_tokens=suppress_tokens,
            batch_size=batch_size,
        )
    else:
        segment_iter, info = whisper_model.transcribe(
            audio_waveform,
            language_code,
            suppress_tokens=suppress_tokens,
            vad_filter=True,
        )

    segments = list(segment_iter)
    full_transcript = "".join(segment.text for segment in segments)

    del whisper_model, pipeline
    if device.startswith("cuda"):
        torch.cuda.empty_cache()

    return segments, info, full_transcript


def run_diarizer(audio_waveform, device: str):
    diarizer = MSDDDiarizer(torch.device(device) if device.startswith("cuda") else device)
    speaker_turns = diarizer.diarize(torch.from_numpy(audio_waveform).unsqueeze(0))
    del diarizer
    if device.startswith("cuda"):
        torch.cuda.empty_cache()
    return speaker_turns


def normalize_sentences(sentences: Sequence[Dict], speaker_label_map: Dict[str, str]):
    normalized = []
    for item in sentences:
        mapped = dict(item)
        mapped["speaker"] = speaker_label_map[mapped["speaker"]]
        mapped["text"] = mapped.get("text", "").strip()
        normalized.append(mapped)
    return normalized


def calculate_speaker_stats(sentences: Sequence[Dict]) -> Dict[str, Dict[str, int]]:
    stats: Dict[str, Dict[str, int]] = {}
    for sentence in sentences:
        label = sentence["speaker"]
        duration = max(int(sentence["end_time"]) - int(sentence["start_time"]), 0)
        stat = stats.setdefault(label, {"durationMs": 0, "segments": 0})
        stat["durationMs"] += duration
        stat["segments"] += 1
    return stats


def export_transcripts(output_dir: Path, sentences: Sequence[Dict]):
    transcript_path = output_dir / "transcript.txt"
    srt_path = output_dir / "segments.srt"
    csv_path = output_dir / "segments.csv"

    with transcript_path.open("w", encoding="utf-8") as handle:
        get_speaker_aware_transcript(sentences, handle)

    with srt_path.open("w", encoding="utf-8") as handle:
        write_srt(sentences, handle)

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["speaker", "start_ms", "end_ms", "duration_ms", "transcript"])
        for sentence in sentences:
            start_ms = int(sentence["start_time"])
            end_ms = int(sentence["end_time"])
            writer.writerow(
                [
                    sentence["speaker"],
                    start_ms,
                    end_ms,
                    max(end_ms - start_ms, 0),
                    sentence["text"],
                ]
            )

    return {
        "transcript": str(transcript_path),
        "srt": str(srt_path),
        "csv": str(csv_path),
    }


def build_segments(sentences: Sequence[Dict]):
    segments = []
    for sentence in sentences:
        start_ms = int(sentence["start_time"])
        end_ms = int(sentence["end_time"])
        segments.append(
            {
                "id": str(uuid.uuid4()),
                "speakerLabel": sentence["speaker"],
                "startMs": start_ms,
                "endMs": end_ms,
                "durationMs": max(end_ms - start_ms, 0),
                "transcript": sentence["text"],
            }
        )
    return segments


def main() -> int:
    args = build_arg_parser().parse_args()

    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="[%(levelname)s] %(message)s",
        stream=sys.stderr,
    )

    ensure_nltk_resources()

    audio_path = Path(args.audio).expanduser().resolve()
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    output_dir = Path(args.out).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    device = compute_device(args.device)
    logging.info("Using device: %s", device)

    temp_root = Path.cwd() / "temp_outputs"
    if os.name == "nt":
        os.environ.setdefault("FFMPEG_BINARY", "ffmpeg")

    try:
        vocal_source = maybe_separate_vocals(audio_path, device, temp_root, args.no_stem)
        audio_waveform = decode_audio(str(vocal_source))

        language_code = process_language_arg(args.language, args.whisper_model)
        segments, info, full_transcript = run_whisper_transcription(
            audio_waveform,
            language_code,
            args.whisper_model,
            device,
            args.batch_size,
            args.suppress_numerals,
        )

        language_resolved = info.language or language_code or "en"
        iso_language = langs_to_iso.get(language_resolved, "eng")

        alignment_model, alignment_tokenizer = load_alignment_model(
            "cuda" if device.startswith("cuda") else "cpu",
            dtype=torch.float16 if device.startswith("cuda") else torch.float32,
        )

        emissions, stride = generate_emissions(
            alignment_model,
            torch.from_numpy(audio_waveform).to(alignment_model.dtype).to(alignment_model.device),
            batch_size=args.batch_size,
        )
        del alignment_model
        if device.startswith("cuda"):
            torch.cuda.empty_cache()

        tokens_starred, text_starred = preprocess_text(
            full_transcript,
            romanize=True,
            language=iso_language,
        )

        align_segments, scores, blank_token = get_alignments(
            emissions,
            tokens_starred,
            alignment_tokenizer,
        )
        spans = get_spans(tokens_starred, align_segments, blank_token)
        word_timestamps = postprocess_results(text_starred, spans, stride, scores)

        speaker_turns = run_diarizer(audio_waveform, device)

        if not speaker_turns:
            raise RuntimeError("No speaker turns detected")

        word_speaker_mapping = get_words_speaker_mapping(word_timestamps, speaker_turns, "start")

        if language_resolved in punct_model_langs:
            logging.info("Restoring punctuation with deepmultilingualpunctuation model")
            try:
                punctuation_model = PunctuationModel(model="kredor/punctuate-all")
                words_list = [entry["word"] for entry in word_speaker_mapping]
                labeled_words = punctuation_model.predict(words_list, chunk_size=230)
                ending_punctuations = ".?!"
                punctuation_chars = ".,;:!?"

                def is_acronym(word: str) -> bool:
                    return bool(word) and word.replace(".", "").isalpha() and word.count(".") >= 2

                # labeled_words is a list of strings with punctuation added
                for entry, labeled_word in zip(word_speaker_mapping, labeled_words):
                    word = entry["word"]
                    # Convert to string if it's a numpy type or other non-string type
                    if not isinstance(labeled_word, str):
                        labeled_word = str(labeled_word) if labeled_word is not None else ""
                    # Extract the punctuation from the end of the labeled word
                    if labeled_word and len(labeled_word) > 0 and labeled_word[-1] in ending_punctuations:
                        punctuation = labeled_word[-1]
                        if (
                            word
                            and (word[-1] not in punctuation_chars or is_acronym(word))
                        ):
                            entry["word"] = word.rstrip(".") + punctuation
            except Exception as e:
                logging.warning("Punctuation restoration failed, continuing without it: %s", e)
        else:
            logging.info("Skipping punctuation restoration for language %s", language_resolved)

        realigned_mapping = get_realigned_ws_mapping_with_punctuation(word_speaker_mapping)
        sentences = get_sentences_speaker_mapping(realigned_mapping, speaker_turns)

        if not sentences:
            raise RuntimeError("No sentences produced after alignment")

        unique_speakers = []
        for sentence in sentences:
            label = sentence["speaker"]
            if label not in unique_speakers:
                unique_speakers.append(label)

        speaker_label_map = {label: f"Speaker {index + 1}" for index, label in enumerate(unique_speakers)}
        normalized_sentences = normalize_sentences(sentences, speaker_label_map)

        segments_payload = build_segments(normalized_sentences)
        speaker_stats = calculate_speaker_stats(normalized_sentences)
        speaker_entries = []
        for original_label in unique_speakers:
            mapped_label = speaker_label_map[original_label]
            stats = speaker_stats.get(mapped_label, {"segments": 0, "durationMs": 0})
            speaker_entries.append(
                {
                    "label": mapped_label,
                    "displayName": mapped_label,
                    "originalLabel": original_label,
                    "segments": stats["segments"],
                    "durationMs": stats["durationMs"],
                }
            )

        files = export_transcripts(output_dir, normalized_sentences)

        payload = {
            "meetingId": args.meeting,
            "status": "done",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "device": device,
            "whisperModel": args.whisper_model,
            "language": language_resolved,
            "durationMs": int(info.duration * 1000) if getattr(info, "duration", None) else None,
            "speakers": speaker_entries,
            "segments": segments_payload,
            "transcript": full_transcript.strip(),
            "files": files,
            "speakerStats": speaker_stats,
        }

        output_path = output_dir / "diarization.json"
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        sys.stdout.flush()

    finally:
        try:
            cleanup(str(temp_root))
        except ValueError:
            pass

    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - safety net
        error_payload = {"status": "failed", "error": str(exc)}
        sys.stdout.write(json.dumps(error_payload, ensure_ascii=False))
        sys.stdout.flush()
        logging.exception("Diarization failed")
        sys.exit(1)

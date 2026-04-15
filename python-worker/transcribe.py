#!/usr/bin/env python3
"""
Production transcription worker: WhisperX (default) with alignment + optional diarization,
or faster-whisper fallback with timestamps and speaker \"Unknown\".

Stderr lines prefixed with GLASSCALL_PROGRESS emit JSON for UI phases.
Stdout: single JSON line with paths and stats (last line must be the result object).

Environment:
  HF_TOKEN / HUGGING_FACE_HUB_TOKEN — required for pyannote diarization models (free, license acceptance on HF)
  GLASSCALL_DEVICE — optional: cpu | mps | cuda (default: mps on Apple Silicon if available, else cpu)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any


def eprint_progress(phase: str, detail: str | None = None) -> None:
    payload: dict[str, Any] = {"phase": phase}
    if detail:
        payload["detail"] = detail
    sys.stderr.write(f"GLASSCALL_PROGRESS {json.dumps(payload, ensure_ascii=False)}\n")
    sys.stderr.flush()


def format_ts(seconds: float) -> str:
    s = max(0.0, float(seconds))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    if h > 0:
        return f"{h:d}:{m:02d}:{sec:02d}"
    return f"{m:02d}:{sec:02d}"


def merge_two_tracks(system_path: Path, mic_path: Path, out_wav: Path, mic_gain_db: float = 0.0) -> None:
    """Mono mix for ASR/diarization — optional mic gain (dB) on the mic input before mixing."""
    gain = max(0.0, min(24.0, float(mic_gain_db)))
    if gain != 0.0:
        filter_complex = (
            f"[1:a]volume={gain}dB[mic];"
            "[0:a][mic]amix=inputs=2:duration=longest:dropout_transition=2[aout]"
        )
    else:
        filter_complex = "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(system_path),
        "-i",
        str(mic_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[aout]",
        "-ar",
        "16000",
        "-ac",
        "1",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def segments_to_txt(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for seg in segments:
        sp = str(seg.get("speaker", "Unknown"))
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", 0.0))
        text = str(seg.get("text", "")).strip()
        lines.append(f"[{format_ts(start)}–{format_ts(end)}] {sp}: {text}")
    return "\n".join(lines).strip() + ("\n" if lines else "")


def segments_to_summarizer_text(segments: list[dict[str, Any]]) -> str:
    """Rich lines for LM Studio: timestamps + speaker labels."""
    lines: list[str] = []
    for seg in segments:
        sp = str(seg.get("speaker", "Unknown"))
        start = float(seg.get("start", 0.0))
        t = format_ts(start)
        text = str(seg.get("text", "")).strip()
        lines.append(f"[{t}] {sp}: {text}")
    return "\n".join(lines).strip()


def run_faster_whisper_fallback(
    audio_path: Path,
    language: str | None,
    model_size: str,
    device: str,
) -> tuple[list[dict[str, Any]], str | None, float]:
    from faster_whisper import WhisperModel

    eprint_progress("transcribe", "faster-whisper fallback")
    compute = "int8" if device == "cpu" else "float16"
    model = WhisperModel(model_size, device=device if device != "mps" else "cpu", compute_type=compute)
    lang = None if language == "auto" else language
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=lang,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        condition_on_previous_text=False,
        temperature=0.0,
        hallucination_silence_threshold=2.0,
    )
    segs: list[dict[str, Any]] = []
    duration = 0.0
    for seg in segments_iter:
        duration = max(duration, float(seg.end))
        segs.append(
            {
                "speaker": "Unknown",
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
            }
        )
    detected = getattr(info, "language", None)
    return segs, detected, duration


def _get_diarization_pipeline():
    import whisperx

    if hasattr(whisperx, "DiarizationPipeline"):
        return whisperx.DiarizationPipeline
    try:
        from whisperx.diarize import DiarizationPipeline

        return DiarizationPipeline
    except ImportError:
        return None


def run_whisperx(
    audio_path: Path,
    language: str | None,
    model_name: str,
    diarize: bool,
    hf_token: str | None,
    batch_size: int,
    device: str,
) -> tuple[list[dict[str, Any]], str | None, float, bool]:
    import torch
    import whisperx

    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"
    compute_type = "float32" if device == "cpu" else "float16"

    eprint_progress("transcribe", "whisperx load + transcribe")
    audio = whisperx.load_audio(str(audio_path))
    # Anti-hallucination ASR options. Whisper fabricates text on silence, music,
    # and poor-SNR segments unless these thresholds are tightened.
    asr_options = {
        "no_speech_threshold": 0.6,
        "log_prob_threshold": -1.0,
        "compression_ratio_threshold": 2.4,
        "condition_on_previous_text": False,
        "temperatures": [0.0],
        "hallucination_silence_threshold": 2.0,
    }
    model = whisperx.load_model(
        model_name,
        device,
        compute_type=compute_type,
        language=language,
        asr_options=asr_options,
    )
    result = model.transcribe(audio, batch_size=batch_size)
    detected_lang = result.get("language")

    eprint_progress("align", "whisperx alignment")
    align_lang = detected_lang or language or "en"
    model_a, metadata = whisperx.load_align_model(language_code=align_lang, device=device)
    result = whisperx.align(
        result["segments"],
        model_a,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    diarization_applied = False
    if diarize and hf_token:
        Pipe = _get_diarization_pipeline()
        if Pipe is None:
            eprint_progress("diarize", "DiarizationPipeline not available in this whisperx build")
        else:
            try:
                eprint_progress("diarize", "pyannote speaker diarization")
                diarize_model = Pipe(use_auth_token=hf_token, device=device)
                diarize_segments = diarize_model(audio)
                result = whisperx.assign_word_speakers(diarize_segments, result)
                diarization_applied = True
            except Exception as ex:  # noqa: BLE001
                eprint_progress("diarize", f"failed: {ex!s} — continuing without speaker labels")
                sys.stderr.write(traceback.format_exc())
                diarization_applied = False

    segments_out: list[dict[str, Any]] = []
    audio_arr = audio
    duration = float(len(audio_arr) / 16000.0) if hasattr(audio_arr, "__len__") else 0.0

    for seg in result.get("segments", []):
        text = str(seg.get("text", "")).strip()
        sp = seg.get("speaker")
        if sp is None or sp == "":
            sp = "Unknown"
        else:
            sp = str(sp)
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        segments_out.append({"speaker": sp, "start": start, "end": end, "text": text})
        duration = max(duration, end)

    return segments_out, detected_lang if isinstance(detected_lang, str) else None, duration, diarization_applied


def pick_device() -> str:
    env = os.environ.get("GLASSCALL_DEVICE", "").strip().lower()
    if env in ("cpu", "mps", "cuda"):
        return env
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def main() -> int:
    parser = argparse.ArgumentParser(description="GlassCall transcription + diarization worker")
    parser.add_argument("--input", required=True, help="Primary audio (mixed system or system track)")
    parser.add_argument("--input-mic", default="", help="Optional second track (mic) to mix with --input")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--basename", required=True, help="Base filename without extension for outputs")
    parser.add_argument("--backend", default="whisperx", choices=["whisperx", "faster_whisper", "vibevocal_asr"])
    parser.add_argument("--language", default="auto")
    parser.add_argument("--diarize", action="store_true")
    parser.add_argument("--no-diarize", action="store_true")
    parser.add_argument("--hf-token", default="", help="Hugging Face token for pyannote (or set HF_TOKEN)")
    parser.add_argument("--whisperx-model", default="large-v3")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--faster-model", default="small", help="faster_whisper model id when backend=faster_whisper or fallback")
    parser.add_argument(
        "--mic-gain-db",
        type=float,
        default=0.0,
        help="Gain (dB) applied to microphone track before mixing with system audio (0–24 typical)",
    )
    args = parser.parse_args()

    if args.backend == "vibevocal_asr":
        sys.stderr.write("vibevocal_asr backend is not implemented in this build.\n")
        return 2

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = args.basename
    json_path = out_dir / f"{base}.transcript.json"
    txt_path = out_dir / f"{base}.transcript.txt"

    primary = Path(args.input)
    if not primary.is_file():
        print(json.dumps({"ok": False, "error": f"missing input {primary}"}))
        return 1

    work_audio = primary
    tmp_wav: Path | None = None
    mic_path = Path(args.input_mic) if args.input_mic.strip() else None
    mic_gain_db = max(0.0, min(24.0, float(args.mic_gain_db)))
    if mic_path and mic_path.is_file():
        eprint_progress("prepare", "mixing system + microphone to mono WAV")
        tmp_wav = Path(tempfile.mkdtemp(prefix="glasscall_")) / "mixed.wav"
        try:
            merge_two_tracks(primary, mic_path, tmp_wav, mic_gain_db)
            work_audio = tmp_wav
        except Exception as ex:  # noqa: BLE001
            sys.stderr.write(f"ffmpeg mix failed, using system track only: {ex}\n")
            work_audio = primary
            tmp_wav = None

    language = None if args.language.lower() == "auto" else args.language
    diarize = bool(args.diarize) and not args.no_diarize
    hf_token = (args.hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip() or None
    if diarize and not hf_token:
        eprint_progress("diarize", "no HF token — diarization skipped (set HF_TOKEN or --hf-token)")
        diarize = False

    device = pick_device()
    segments: list[dict[str, Any]] = []
    detected_lang: str | None = None
    duration_sec = 0.0
    diarization_applied = False
    backend_used = args.backend

    try:
        if args.backend == "whisperx":
            try:
                wx_device = "cpu" if device == "mps" else device
                segments, detected_lang, duration_sec, diarization_applied = run_whisperx(
                    work_audio,
                    language,
                    args.whisperx_model,
                    diarize,
                    hf_token,
                    max(2, min(args.batch_size, 16)),
                    wx_device,
                )
            except Exception as ex:  # noqa: BLE001
                sys.stderr.write(f"WhisperX failed: {ex!s}\n")
                sys.stderr.write(traceback.format_exc())
                eprint_progress("transcribe", "falling back to faster-whisper")
                segments, detected_lang, duration_sec = run_faster_whisper_fallback(
                    work_audio, language, args.faster_model, "cpu"
                )
                backend_used = "faster_whisper"
                diarization_applied = False
        else:
            segments, detected_lang, duration_sec = run_faster_whisper_fallback(
                work_audio, language, args.faster_model, "cpu"
            )
            diarization_applied = False
    finally:
        if tmp_wav and tmp_wav.exists():
            try:
                tmp_wav.unlink()
            except OSError:
                pass

    # Normalize segment keys for JSON
    clean_segments = []
    for s in segments:
        clean_segments.append(
            {
                "speaker": s.get("speaker") or "Unknown",
                "start": float(s.get("start", 0.0)),
                "end": float(s.get("end", 0.0)),
                "text": str(s.get("text", "")).strip(),
            }
        )

    payload = {
        "duration_seconds": duration_sec,
        "language": detected_lang,
        "segments_count": len(clean_segments),
        "diarization_applied": diarization_applied,
        "backend": backend_used,
        "segments": clean_segments,
    }
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    human_txt = segments_to_txt(clean_segments)
    summarizer_txt = segments_to_summarizer_text(clean_segments)
    txt_path.write_text(human_txt + "\n", encoding="utf-8")

    out = {
        "ok": True,
        "duration_seconds": duration_sec,
        "language": detected_lang,
        "segments_count": len(clean_segments),
        "transcript_json": str(json_path),
        "transcript_txt": str(txt_path),
        "summarizer_text": summarizer_txt,
        "diarization_applied": diarization_applied,
        "backend": backend_used,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

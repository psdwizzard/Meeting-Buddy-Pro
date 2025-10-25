# Meeting Buddy Pro Architecture (Draft)

## Overview
Meeting Buddy Pro is a cross-platform desktop application built with Electron, a Node.js/React stack, and a Python-based diarization engine (MahmoudAshraf97/whisper-diarization). The app records meetings, runs offline multi-speaker diarized transcription, lets users manage speaker identities, and keeps historical meetings accessible in a dark-themed interface.

## Components
- **Electron shell**: Primary distribution target delivering desktop UX, system microphone capture, GPU access, and dark-mode theming. Provides a browser build as a secondary option for development.
- **Frontend (React + Tailwind)**: Dark interface for starting/ending meetings, renaming speakers, browsing transcripts, and exporting data.
- **Backend (Express + SQLite via Prisma)**: Handles meeting lifecycle, persists speaker mappings/transcripts, coordinates the diarization jobs, and manages media file storage (WAV/FLAC).
- **Diarization bridge (Python)**: Wraps the `whisper-diarization` project, exposing a CLI/IPC interface launched from Node child processes. The runner writes `diarization.json`, `segments.csv`, `segments.srt`, and `transcript.txt` per meeting and supports GPU execution through CUDA/cuDNN on the RTX 3090 with CPU fallback.

## Data Model (initial)
- **Meeting**
  - id (uuid)
  - name
  - createdAt / startedAt / endedAt
  - audioFilePath
  - transcriptionStatus (pending, processing, done, failed)
- **Speaker**
  - id
  - meetingId
  - label (Speaker 1, Speaker 2, ...)
  - displayName (user-editable, default matches label)
- **Segment**
  - id
  - meetingId
  - speakerId
  - startTimeMs / endTimeMs
  - transcript

Renaming a speaker updates `displayName` only; historical segments remain linked automatically.

## Meeting Flow
1. User creates & starts a meeting (defaults to numbered speakers).
2. Audio is captured from the PC microphone via Electron's media APIs (optional audio import supported pre-diarization).
3. User ends the meeting; backend queues the diarization job once audio is finalized.
4. Node spawns Python script: `python .\services\diarization\run.py --audio <file> --out <dir> --device cuda`.
5. Output JSON parsed and stored in SQLite; UI refreshes transcript view when processing completes.
6. User can rename speakers; updates propagate instantly via database change.

## Recording & Imports
- Primary workflow records audio directly inside the Electron app.
- Users may optionally import finished audio files for diarization without recording.

## Security & Storage
- All data (audio, transcripts, SQLite database) persists locally to keep meetings private.
- No cloud sync or external data transfer is performed unless explicitly added later.

## Exports
- Provide transcript exports as CSV (speaker, start, end, text) or plain text files per meeting.
- Future enhancement: combine CSV with metadata (meeting name, timestamps) for easy archival.

## GPU Acceleration
- Ship Python venv with torch+CUDA, whisperx dependencies, and NVIDIA NeMo.
- Detect GPU availability on boot; allow user to toggle CPU fallback.
- Document prerequisites (NVIDIA driver, CUDA toolkit, cuDNN) in README and `install.bat`.

## Scripts
- `install.bat`
  - Validates Node.js & Python 3.10+
  - Installs npm deps (root, app, backend)
  - Sets up Python venv under `./.venv`
  - Installs `whisper-diarization` requirements with GPU extras
- `run.bat`
  - Activates venv
  - Launches Electron app via `npm run dev`
  - Ensures diarization service path on PYTHONPATH

## Open Questions
1. Preferred packaging targets for production builds (MSI, DMG, AppImage)?
2. Should we expose transcript redaction/anonymization tools for sensitive meetings?
3. Any automated backup/export strategy needed beyond manual CSV/text downloads?


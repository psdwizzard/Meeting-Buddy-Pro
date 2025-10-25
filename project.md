# Meeting Buddy Pro — Project Notes

## Current Capabilities
- **Modern UI**: Electron + React desktop client with Tailwind CSS, dark-mode design, and Material Icons.
- **Two-Column Layout**: Meeting list sidebar (25%) with meeting details panel (75%).
- **Meeting Management**: Create, rename, and organize meetings with editable names.
- **Local SQLite Backend**: via better-sqlite3 for meetings, speakers, and diarized segments.
- **GPU-Accelerated Transcription**: Python diarization harness built on whisper-diarization with CUDA support (PyTorch 2.6.0+cu124).
- **In-App Recording**: Microphone capture using MediaRecorder, streamed through Electron to disk.
- **Automatic Diarization**: Triggered on recording stop and manual audio uploads.
- **Speaker Management**: Edit speaker names, add missing speakers post-recording.
- **Transcript Viewer**: In-app scrollable transcript viewer with automatic refresh on completion.
- **Auto-Polling**: UI refreshes every 10 seconds during processing to show real-time status updates.
- **Export Artifacts**: Per-meeting exports (`diarization.json`, `segments.csv`, `segments.srt`, `transcript.txt`) with download buttons.

## Recent Updates (Oct 24, 2025)

### GPU Acceleration Enabled
- Fixed TorchCodec dependency error by replacing `torchaudio.save()` with `soundfile.write()` in MSDD diarizer.
- Fixed punctuation restoration compatibility issues with deepmultilingualpunctuation model.
- Upgraded from PyTorch 2.9.0 CPU to PyTorch 2.6.0+cu124 for NVIDIA RTX 3090 GPU acceleration.
- Diarization now runs on CUDA, dramatically reducing processing time (10-30x faster).

### UI/UX Improvements
- Redesigned with Tailwind CSS v4 and Google Fonts (Inter).
- Two-column layout: meeting list sidebar + detailed meeting view.
- Editable meeting names (click to edit, Enter to save).
- Plus button (+) to create new meetings with auto-focus on name field.
- In-app transcript viewer with scrollable content area.
- Automatic UI refresh when processing completes (10-second polling).
- Speaker management: edit names and add speakers post-recording.
- Material Symbols Outlined icons throughout.

### Backend Enhancements
- Added `PATCH /api/meetings/:meetingId` endpoint for updating meeting names.
- Added `PATCH /api/meetings/:meetingId/speakers/:speakerId` endpoint for renaming speakers.
- Added `POST /api/meetings/:meetingId/speakers` endpoint for adding new speakers.
- Enhanced storage module with `updateMeeting()` and `addSpeaker()` functions.

### Bug Fixes
- Resolved CORS and meeting payload errors.
- Fixed transcript not loading automatically when processing completes.
- Added proper error handling for punctuation restoration failures.
- Ensured outputs directory structure is created automatically.

## Install / Run Checklist
1. `install.bat` (sets up Node deps, Python venv, megatron-core, torchcodec, soundfile, demucs).
2. `run.bat` (starts backend, Vite renderer, Electron shell on port 3410 / 5173).
3. Allow microphone access on first recording.

### Runtime Assets
- Audio recordings: `data/audio/<meetingId>/recording-*.webm`.
- Diarization exports: `data/outputs/<meetingId>/{segments.csv,segments.srt,transcript.txt,diarization.json}`.
- SQLite DB: `data/meeting-buddy.db`.

## Known Gaps / Next Steps
- Re-enable Demucs source separation once a compatible FFmpeg/TorchCodec configuration is verified (optional).
- Add delete functionality for meetings and speakers.
- Add progress indicators during diarization processing.
- Improve error notifications with toast/banner UI.
- Packaging: create production builds (MSI/DMG/AppImage) once feature set stabilizes.
- Add automated tests for backend endpoints and diarization bridge once the pipeline is stable.

## Dependency Notes
- **PyTorch**: 2.6.0+cu124 (CUDA 12.4) for GPU acceleration on NVIDIA RTX 3090.
- **Tailwind CSS**: v4 with @tailwindcss/postcss plugin.
- **whisper-diarization**: editable install with NeMo for speaker diarization.
- **soundfile**: Used instead of torchaudio for audio I/O to avoid TorchCodec dependency.
- **FFmpeg**: Not required (Demucs stem splitting disabled by default).


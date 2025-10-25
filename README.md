# Meeting Buddy Pro

Meeting Buddy Pro is a desktop meeting assistant built with Electron, React, and a GPU-accelerated Whisper diarization pipeline. Record or upload meetings, run diarization/transcription locally, manage speakers, and export transcripts in multiple formats.

## Features
- **Modern desktop UI** with Tailwind-styled two-column layout for meeting browsing and details.
- **Local SQLite storage** for meetings, speakers, and diarized segments.
- **Audio ingest** via in-app recording or file uploads, persisted to `data/audio/`.
- **GPU Whisper diarization** (PyTorch + NeMo) with automatic export of TXT/CSV/SRT/JSON artifacts per meeting.
- **Speaker management** to add/rename speakers and retroactively apply names to exports.
- **Model menu + reprocess** flow to pick a Whisper model (tiny ? large-v3-turbo) and re-run transcription on completed meetings.
- **Download center** for transcript artifacts and live transcript viewer inside the app.

## Getting Started
1. **Install prerequisites**
   - Node.js 18+
   - Python 3.10+ with build tooling (for PyTorch/whisper-diarization)
   - Git, C++ build tools, and an NVIDIA GPU w/ CUDA 12.4+ (recommended)
2. **Install dependencies**
   ```powershell
   ./install.bat
   ```
3. **Run the app**
   ```powershell
   ./run.bat
   ```
   This boots the backend API (port 3410), Vite dev server (5173), and Electron shell.

## Daily Workflow
1. **Create or select a meeting** from the sidebar.
2. **Record** using the in-app Start/Stop controls *or* upload audio. Files land in `data/audio/<meetingId>/`.
3. Diarization kicks off automatically. Check status in the meeting header (`Pending ? Processing ? Done`).
4. **Speakers**: rename participants inline, optionally tap **Process Names** to rewrite transcripts/exports with your custom names.
5. **Downloads**: grab TXT/CSV/SRT from the Transcript card or read the inline viewer.

## Whisper Model Selection & Reprocessing
- The Electron menu now includes a **Model** section with radio buttons for common Whisper checkpoints (`tiny`, `base`, `small.en`, `large-v3-turbo`, etc.).
- Selecting a model stores the preference in your user data folder and updates `DIARIZATION_WHISPER_MODEL` for new recordings.
- Use **Model ? Reprocess Active Meeting** (or `Cmd/Ctrl+Shift+R`) to re-run diarization on the currently selected meeting. The UI shows a banner while processing and disables speaker tools until the job finishes.

## Configuration Notes
- `.env` (optional) can override API port, diarization batch size, min/max speakers, etc.
- Outputs live under `data/outputs/<meetingId>/` with `segments.csv`, `segments.srt`, `transcript.txt`, `diarization.json`.
- All data is local; delete `data/` to reset (or prune individual meeting folders).

## Repository Structure
```
backend/   # Express API + diarization bridge
src/       # React renderer (Vite)
electron/  # Main/Preload scripts + menu wiring
services/  # Python diarization harness (run.py)
data/      # SQLite DB, audio, exports (created at runtime)
```

## Contributing
1. Fork/clone the repo.
2. Run `./install.bat` once, then `./run.bat` during development.
3. Submit PRs with clear descriptions and include screenshots for UI tweaks when possible.

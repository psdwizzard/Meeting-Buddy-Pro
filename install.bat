@echo off
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul

echo [1/8] Checking Node.js runtime...
node -v >nul 2>&1
if errorlevel 1 (
  echo Node.js is required but not installed. Install Node.js 18 or later and rerun install.bat.
  goto :error
)
node -e "process.exit(parseInt(process.versions.node.split('.')[0],10) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or later is required. Current version is insufficient.
  goto :error
)

echo [2/8] Checking Python runtime...
python --version >nul 2>&1
if errorlevel 1 (
  echo Python 3.10 or later is required. Install Python and rerun install.bat.
  goto :error
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
  echo Python 3.10 or later is required. Current interpreter is too old.
  goto :error
)

echo [3/8] Installing npm dependencies...
call npm install || goto :error

echo [4/8] Creating Python virtual environment (.venv)...
if not exist .venv (
  python -m venv .venv || goto :error
)

echo [5/8] Upgrading pip in the virtual environment...
call .venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel || goto :error

echo [6/8] Ensuring python3 shim inside virtual environment...
if not exist .venv\Scripts\python3.exe (
  copy /Y .venv\Scripts\python.exe .venv\Scripts\python3.exe >nul || goto :error
)

echo [7/8] Installing Python dependencies for diarization...
if exist whisper-diarization
equirements.txt (
  call .venv\Scripts\python.exe -m pip install -r whisper-diarization
equirements.txt || goto :error
)
call .venv\Scripts\python.exe -m pip install -e whisper-diarization || goto :error

echo [8/8] Installing megatron-core (required by NVIDIA NeMo)...
call .venv\Scripts\python.exe -m pip install megatron-core || goto :error

echo Installing torchcodec (torchaudio dependency)...
call .venv\Scripts\python.exe -m pip install torchcodec || goto :error

echo Installing soundfile (torchaudio fallback)...
call .venv\Scripts\python.exe -m pip install soundfile || goto :error

echo Installing demucs with CPU extras...
call .venv\Scripts\python.exe -m pip install "demucs[cpu]" || goto :error

echo.
echo Installation complete. Use run.bat to start Meeting Buddy Pro.
popd >nul
exit /b 0

:error
echo.
echo Installation failed. Review the messages above for details.
popd >nul
exit /b 1

@echo off
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul

if not exist .venv\Scripts\activate.bat (
  echo Python virtual environment not found. Run install.bat first.
  goto :error
)

call .venv\Scripts\activate.bat

set "PYTHONPATH=%SCRIPT_DIR%services;%SCRIPT_DIR%whisper-diarization;%PYTHONPATH%"
if not defined PORT set "PORT=3410"
set "MEETING_BUDDY_QUICK_RECORD=1"

npm run dev
set EXIT_CODE=%ERRORLEVEL%

deactivate >nul 2>&1
popd >nul
exit /b %EXIT_CODE%

:error
echo.
popd >nul
exit /b 1

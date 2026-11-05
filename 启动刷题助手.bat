@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Shuati Helper

if not exist "server.py" (
  echo [ERROR] server.py not found. Please keep the project files together.
  pause
  exit /b 1
)

where py >nul 2>nul
if errorlevel 1 (
  set "PYTHON=python"
  where python >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Python was not found. Please install Python 3.10 or newer.
    echo https://www.python.org/downloads/
    pause
    exit /b 1
  )
) else (
  set "PYTHON=py"
)

%PYTHON% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python 3.10 or newer is required.
  pause
  exit /b 1
)

%PYTHON% -c "import rapidocr_onnxruntime, PIL, cv2, numpy" >nul 2>nul
if errorlevel 1 (
  echo.
  echo First run: installing the local OCR engine. This may take a few minutes.
  echo.
  %PYTHON% -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
  if errorlevel 1 (
    echo.
    echo [ERROR] Installation failed. Check your network and run the dependency installer again.
    pause
    exit /b 1
  )
)

echo.
echo Starting Shuati Helper...
%PYTHON% server.py %*
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo The server stopped unexpectedly. Exit code: %EXIT_CODE%
  pause
)
endlocal

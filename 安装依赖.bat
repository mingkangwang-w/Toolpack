@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Shuati Helper - Setup

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

echo Checking the local OCR engine...
%PYTHON% -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
if errorlevel 1 (
  echo.
  echo [ERROR] Installation failed. Try the default index instead:
  echo   %PYTHON% -m pip install -r requirements.txt
  pause
  exit /b 1
)

echo.
echo Done. You can now double-click the start script in this folder.
pause
endlocal

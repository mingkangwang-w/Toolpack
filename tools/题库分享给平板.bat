@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 题库分享给平板

where py >nul 2>nul
if errorlevel 1 (
  set "PYTHON=python"
) else (
  set "PYTHON=py"
)

%PYTHON% serve_library_share.py
pause
endlocal

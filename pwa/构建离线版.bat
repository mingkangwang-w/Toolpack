@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title 构建刷题助手离线版

where py >nul 2>nul
if errorlevel 1 (
  set "PYTHON=python"
) else (
  set "PYTHON=py"
)

%PYTHON% build_offline.py
if errorlevel 1 (
  echo.
  echo [错误] 离线版构建失败。
  pause
  exit /b 1
)

if not exist "pwa\release" mkdir "pwa\release"
powershell -NoProfile -Command "Compress-Archive -Path 'dist-offline\*' -DestinationPath 'pwa\release\刷题助手-离线版-PWA.zip' -Force"

echo.
echo 构建完成：
echo   dist-offline\
echo   pwa\release\刷题助手-离线版-PWA.zip
echo.
echo 把 dist-offline 的全部文件部署到 HTTPS 静态站点，
echo 或在 pwa 文件夹运行「局域网安装离线版.bat」直接安装到平板。
pause
endlocal

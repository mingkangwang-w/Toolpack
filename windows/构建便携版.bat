@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title 构建刷题助手便携版

where py >nul 2>nul
if errorlevel 1 (
  set "PYTHON=python"
  where python >nul 2>nul
  if errorlevel 1 (
    echo [错误] 没有找到 Python。构建者需要安装 Python 3.10 或更新版本。
    pause
    exit /b 1
  )
) else (
  set "PYTHON=py"
)

%PYTHON% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo [错误] 需要 Python 3.10 或更新版本。
  pause
  exit /b 1
)

%PYTHON% -c "import rapidocr_onnxruntime, PIL, cv2, numpy" >nul 2>nul
if errorlevel 1 (
  echo 正在安装 OCR 依赖...
  %PYTHON% -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
  if errorlevel 1 (
    echo [错误] OCR 依赖安装失败。
    pause
    exit /b 1
  )
)

%PYTHON% -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  echo 正在安装 PyInstaller...
  %PYTHON% -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
  if errorlevel 1 (
    echo [错误] PyInstaller 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 正在清理旧构建...
if exist "build" rmdir /s /q "build"
if exist "windows\release\刷题助手" rmdir /s /q "windows\release\刷题助手"
if exist "windows\release\刷题助手-便携版.zip" del /q "windows\release\刷题助手-便携版.zip"
if exist "windows\release\刷题助手-含题库-便携版.zip" del /q "windows\release\刷题助手-含题库-便携版.zip"

echo.
echo 正在打包便携版，可能需要几分钟...
%PYTHON% -m PyInstaller --noconfirm --clean --distpath "windows\release" "刷题助手.spec"
if errorlevel 1 (
  echo.
  echo [错误] 打包失败，请查看上方日志。
  pause
  exit /b 1
)

copy /y "%~dp0便携版使用说明.txt" "windows\release\刷题助手\便携版使用说明.txt" >nul
if exist "windows\release\刷题助手\ai-config.json" (
  echo [警告] 输出目录中出现了 ai-config.json，请勿分发该文件！
) else (
  echo AI 配置文件未打入便携版，API Key 安全。
)

echo.
echo 正在生成压缩包...
%PYTHON% "tools\package_portable.py" --source "windows\release\刷题助手" --clean "windows\release\刷题助手-便携版.zip" --with-library "windows\release\刷题助手-含题库-便携版.zip" --library "题库保存"
if errorlevel 1 (
  echo [提示] 压缩包生成失败，但便携版文件夹已经可以使用。
)

echo.
echo 构建完成：
echo   windows\release\刷题助手\刷题助手.exe
echo   windows\release\刷题助手-便携版.zip（不含题库和 AI Key）
echo   windows\release\刷题助手-含题库-便携版.zip（含题库与知识图谱，分享前请确认）
echo.
echo 把整个「刷题助手」文件夹或 zip 发给其他人即可，他们不需要安装 Python。
pause
endlocal

@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title 局域网安装刷题助手离线版

where py >nul 2>nul
if errorlevel 1 (
  set "PYTHON=python"
) else (
  set "PYTHON=py"
)

%PYTHON% -c "import cryptography" >nul 2>nul
if errorlevel 1 (
  echo 正在安装证书生成工具 cryptography...
  %PYTHON% -m pip install cryptography -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
  if errorlevel 1 (
    echo [错误] cryptography 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

%PYTHON% -c "import qrcode" >nul 2>nul
if errorlevel 1 (
  echo 正在安装二维码组件 qrcode...
  %PYTHON% -m pip install "qrcode>=7.4" -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
  if errorlevel 1 (
    echo [提示] qrcode 安装失败，安装页仍可使用，但不会显示二维码。
  )
)

echo.
echo 正在构建离线版...
%PYTHON% build_offline.py
if errorlevel 1 (
  echo [错误] 离线版构建失败。
  pause
  exit /b 1
)

echo.
echo 正在启动局域网 HTTP 安装页和 HTTPS 应用服务...
%PYTHON% tools\serve_offline_lan.py
pause
endlocal

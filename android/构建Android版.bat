@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
title 构建刷题助手 Android 版

where py >nul 2>nul
if errorlevel 1 (
  set "PYTHON=python"
) else (
  set "PYTHON=py"
)

echo.
echo 正在构建平板离线网页...
%PYTHON% build_offline.py
if errorlevel 1 (
  echo [错误] 离线网页构建失败。
  pause
  exit /b 1
)

echo.
echo 正在同步 Capacitor Android 工程...
call npx cap sync android
if errorlevel 1 (
  echo [错误] Capacitor 同步失败。
  pause
  exit /b 1
)

if not exist "android\local.properties" (
  powershell -NoProfile -Command "'sdk.dir=' + ($env:LOCALAPPDATA -replace '\\','/') + '/Android/Sdk' | Set-Content -Encoding ASCII 'android\local.properties'"
)
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%LOCALAPPDATA%\Android\Sdk"

if not defined JAVA_HOME (
  if exist "C:\gradle-jdk17" set "JAVA_HOME=C:\gradle-jdk17"
  for /d %%D in ("C:\Program Files\Microsoft\jdk-17*") do set "JAVA_HOME=%%~fD"
)
if not defined JAVA_HOME (
  echo [提示] 没有找到 JDK 17。请安装 Microsoft OpenJDK 17，或设置 JAVA_HOME。
  echo        下载地址：https://learn.microsoft.com/java/openjdk/download
  pause
  exit /b 1
)

echo.
echo 正在编译 Android APK（JDK：%JAVA_HOME%）...
cd android
if exist "keystore.properties" (
  set "BUILD_TASK=assembleRelease"
  set "APK_PATH=app\build\outputs\apk\release\app-release.apk"
  set "APK_NAME=刷题助手-Android.apk"
  set "ZIP_NAME=刷题助手-Android-安装包.zip"
) else (
  echo [提示] 没有找到 android\keystore.properties，改为构建 debug 版本。
  set "BUILD_TASK=assembleDebug"
  set "APK_PATH=app\build\outputs\apk\debug\app-debug.apk"
  set "APK_NAME=刷题助手-Android-debug.apk"
  set "ZIP_NAME=刷题助手-Android-debug-安装包.zip"
)
if exist "C:\gradle-8.2.1\bin\gradle.bat" (
  call "C:\gradle-8.2.1\bin\gradle.bat" !BUILD_TASK! --no-daemon
) else (
  call gradlew.bat !BUILD_TASK! --no-daemon
)
if errorlevel 1 (
  echo.
  echo [错误] Android 编译失败。请查看上方日志。
  cd "%~dp0.."
  pause
  exit /b 1
)
cd /d "%~dp0"

if exist "!APK_PATH!" (
  if not exist "release" mkdir "release"
  copy /y "!APK_PATH!" "release\!APK_NAME!" >nul
  if exist "Android安装说明.txt" (
    powershell -NoProfile -Command "Compress-Archive -Path 'release\!APK_NAME!','Android安装说明.txt' -DestinationPath 'release\!ZIP_NAME!' -Force"
  )
  echo.
  echo 构建完成：
  echo   android\release\!APK_NAME!
  if exist "release\!ZIP_NAME!" echo   android\release\!ZIP_NAME!
) else (
  echo.
  echo [提示] 没有找到 APK，请检查编译日志。
)

pause
endlocal

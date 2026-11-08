# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_all

datas = [("web", "web")]
binaries = []
hiddenimports = []

rapid_datas, rapid_binaries, rapid_hidden = collect_all("rapidocr_onnxruntime")
datas += rapid_datas
binaries += rapid_binaries
hiddenimports += rapid_hidden

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "pytest",
        "unittest",
        "pandas",
        "scipy",
        "matplotlib",
        "cryptography",
        "lxml",
        "IPython",
        "jupyter",
        "notebook",
        "sympy",
        "sklearn",
        "torch",
        "tensorflow",
        "transformers",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="刷题助手",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="刷题助手",
)

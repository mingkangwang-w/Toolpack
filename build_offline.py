"""构建平板离线版 PWA。

输出 dist-offline/：把 web/ 的界面和 offline/ 的 PWA 外壳合并成一个静态站点。
生成后的目录可以直接部署到任意 HTTPS 静态站点；题库和练习数据只保存在平板浏览器中。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
OFFLINE_ROOT = ROOT / "offline"
OUTPUT_ROOT = ROOT / "dist-offline"


def fail(message: str) -> None:
    print(f"[错误] {message}")
    raise SystemExit(1)


def main() -> int:
    if not (WEB_ROOT / "index.html").is_file():
        fail("找不到 web/index.html")
    if not (OFFLINE_ROOT / "index.html").is_file():
        fail("找不到 offline/index.html")

    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    shutil.copytree(WEB_ROOT, OUTPUT_ROOT)

    # 用离线入口覆盖桌面入口，并复制 PWA 外壳。
    shutil.copy2(OFFLINE_ROOT / "index.html", OUTPUT_ROOT / "index.html")
    shutil.copy2(OFFLINE_ROOT / "offline-boot.js", OUTPUT_ROOT / "offline-boot.js")
    shutil.copy2(OFFLINE_ROOT / "manifest.webmanifest", OUTPUT_ROOT / "manifest.webmanifest")
    shutil.copy2(OFFLINE_ROOT / "部署说明.txt", OUTPUT_ROOT / "部署说明.txt")
    shutil.copytree(OFFLINE_ROOT / "icons", OUTPUT_ROOT / "icons")

    files = sorted(
        path
        for path in OUTPUT_ROOT.rglob("*")
        if path.is_file() and path.name != "sw.js"
    )
    if not files:
        fail("没有可打包的静态文件")

    digest = hashlib.sha256()
    digest.update((OFFLINE_ROOT / "sw-template.js").read_bytes())
    precache: list[str] = []
    for path in files:
        relative = path.relative_to(OUTPUT_ROOT).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(path.read_bytes())
        precache.append(f"./{relative}")
    version = digest.hexdigest()[:12]

    template = (OFFLINE_ROOT / "sw-template.js").read_text(encoding="utf-8")
    service_worker = template.replace("__CACHE_VERSION__", version).replace(
        "__PRECACHE__", json.dumps(precache, ensure_ascii=False, indent=2)
    )
    (OUTPUT_ROOT / "sw.js").write_text(service_worker, encoding="utf-8")

    print("离线版构建完成：")
    print(f"  目录：{OUTPUT_ROOT}")
    print(f"  文件：{len(files) + 1} 个，缓存版本：{version}")
    print()
    print("本地预览（localhost 允许注册 Service Worker）：")
    print(f'  py -m http.server 8770 --directory "{OUTPUT_ROOT}"')
    print("  打开 http://127.0.0.1:8770/")
    print()
    print("平板安装：把 dist-offline/ 中的全部文件部署到 HTTPS 静态站点，")
    print("在平板浏览器打开后选择「添加到主屏幕」。安装完成后可断网刷题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

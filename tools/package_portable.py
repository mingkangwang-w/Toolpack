"""生成 Windows 便携版的发布压缩包。

用法（由 windows/构建便携版.bat 调用）：
  py tools/package_portable.py --source windows/release/刷题助手 ^
      --clean windows/release/刷题助手-便携版.zip ^
      --with-library windows/release/刷题助手-含题库-便携版.zip ^
      --library 题库保存

说明：
- 干净包不包含个人题库、ai-config.json 或证书。
- 含题库包会额外加入题库目录，并显式保留隐藏目录
  （例如题库保存/.shuati-knowledge/ 下的知识图谱 JSON）。
- 两包都保留“刷题助手/”顶层目录，解压后可直接运行。
"""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

EXCLUDED_NAMES = {
    "ai-config.json",
    "offline-certs",
    "__pycache__",
    ".ds_store",
    "desktop.ini",
    "thumbs.db",
}
EXCLUDED_SUFFIXES = {".log", ".tmp"}


def is_excluded(relative: Path) -> bool:
    for part in relative.parts:
        lowered = part.lower()
        if lowered in EXCLUDED_NAMES:
            return True
        if lowered.startswith("ai-config") and lowered.endswith((".json", ".tmp")):
            return True
        if lowered == ".env" or lowered.startswith(".env."):
            return True
    return relative.suffix.lower() in EXCLUDED_SUFFIXES


def iter_files(root: Path, skip_top: set[str] | None = None):
    """遍历文件，保留隐藏文件/目录（知识图谱 JSON 就存放在隐藏目录里）。"""
    skip_top = skip_top or set()
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if relative.parts and relative.parts[0] in skip_top:
            continue
        if is_excluded(relative):
            continue
        yield path, relative


def write_zip(output: Path, entries) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, relative in entries:
            archive.write(path, relative.as_posix())
            count += 1
    return count


def build_clean(source: Path, output: Path) -> int:
    prefix = Path(source.name)
    entries = (
        (path, prefix / relative)
        for path, relative in iter_files(source, skip_top={"题库保存"})
    )
    return write_zip(output, entries)


def build_with_library(source: Path, output: Path, library: Path) -> int | None:
    library_root = library if library.is_dir() else source / "题库保存"
    if not library_root.is_dir():
        return None

    prefix = Path(source.name)
    entries = [
        (path, prefix / relative)
        for path, relative in iter_files(source, skip_top={"题库保存"})
    ]
    entries.extend(
        (path, prefix / "题库保存" / relative)
        for path, relative in iter_files(library_root)
    )
    return write_zip(output, entries)


def main() -> int:
    parser = argparse.ArgumentParser(description="打包 Windows 便携版 zip")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--clean", required=True, type=Path)
    parser.add_argument("--with-library", type=Path)
    parser.add_argument("--library", type=Path, default=Path("题库保存"))
    args = parser.parse_args()

    if not args.source.is_dir():
        print(f"[错误] 找不到便携版目录：{args.source}")
        return 1

    clean_count = build_clean(args.source, args.clean)
    print(f"干净包：{args.clean}（{clean_count} 个文件）")

    if args.with_library:
        library_count = build_with_library(args.source, args.with_library, args.library)
        if library_count is None:
            print("[提示] 没有找到题库目录，跳过含题库压缩包。")
        else:
            print(
                f"含题库包：{args.with_library}（{library_count} 个文件，"
                "包含题库保存及隐藏的知识图谱 JSON；分享前请确认内容）"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

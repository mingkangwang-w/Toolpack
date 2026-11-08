"""命令行方式启动局域网题库分享（只读）。

软件内已提供「分享给平板」按钮；这个脚本保留给不开浏览器、只用命令行的场景。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from library_share import DEFAULT_PORT, DEFAULT_TTL_SECONDS, LibraryShareManager  # noqa: E402
from library_store import LibraryError  # noqa: E402


def main() -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, OSError):
        pass

    parser = argparse.ArgumentParser(description="局域网题库分享服务（只读）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--library-dir", default=str(ROOT / "题库保存"))
    parser.add_argument("--code", default="", help="自定义导入码；默认随机 6 位数字")
    parser.add_argument("--ttl", type=int, default=DEFAULT_TTL_SECONDS, help="有效期秒数")
    args = parser.parse_args()

    manager = LibraryShareManager(
        Path(args.library_dir), default_port=args.port, ttl_seconds=args.ttl
    )
    try:
        status = manager.start()
    except LibraryError as exc:
        print(f"[错误] {exc}")
        return 1
    if args.code:
        # 命令行兼容：允许固定导入码，便于脚本测试。
        manager.code = args.code.strip()

    print("")
    print("  题库分享服务已启动（只读）")
    print(f"  题库目录：{manager.library_root}")
    print("")
    for index, address in enumerate(status.get("addresses") or []):
        print(f"  平板电脑地址：{address}:{status['port']}")
        if index == 0 and len(status.get("addresses") or []) > 1:
            print("  （如果第一个地址连不上，请尝试下面列出的其他地址）")
    print(f"  导入码：{manager.code}")
    print(f"  有效期：约 {max(1, args.ttl // 60)} 分钟")
    print("")
    print("  在平板 App 的「配置题库 → 从电脑导入」中填入地址和导入码。")
    print("  按 Ctrl+C 停止服务。")
    print("")

    try:
        while manager.active:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n已停止题库分享服务。")
    finally:
        manager.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())

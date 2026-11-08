"""局域网只读题库分享服务。

桌面主程序通过这个模块在软件内启动/停止分享；平板 App 使用 6 位导入码读取题库。
"""

from __future__ import annotations

import datetime as dt
import hmac
import ipaddress
import json
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from library_store import LibraryError, load_library

DEFAULT_PORT = 8767
DEFAULT_TTL_SECONDS = 600


def local_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    primary = None

    def add(value: str) -> None:
        try:
            ip = ipaddress.ip_address(value)
        except ValueError:
            return
        if (
            ip.version == 4
            and ip.is_private
            and not ip.is_loopback
            and not ip.is_link_local
        ):
            addresses.add(str(ip))

    try:
        for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(entry[4][0])
    except OSError:
        pass

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        primary = sock.getsockname()[0]
        add(primary)
    except OSError:
        pass
    finally:
        sock.close()

    ordered = sorted(addresses, key=lambda item: tuple(int(part) for part in item.split(".")))
    if primary in ordered:
        ordered.remove(primary)
        ordered.insert(0, primary)
    return ordered


def build_library_payload(root: Path) -> dict:
    loaded = load_library(root)
    questions = loaded.get("questions") or []
    if not questions:
        raise LibraryError("题库保存中没有可导入的题目。")
    return {
        "app": "刷题助手",
        "kind": "question-bank",
        "version": 2,
        "exportedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "subjects": loaded.get("subjects") or [],
        "banks": loaded.get("banks") or [],
        "questions": questions,
        "history": [],
        "recentAttempts": {"all": [], "bySubject": {}, "byBank": {}},
        "duplicateIgnores": [],
    }


class ShareHandler(BaseHTTPRequestHandler):
    server_version = "ShuatiHelperShare/1.0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        manager: LibraryShareManager = self.server.share_manager
        if parsed.path == "/api/health":
            self._json(200, {"ok": True, "service": "shuati-library-share"})
            return
        if parsed.path != "/api/library":
            self._json(404, {"ok": False, "error": "接口不存在"})
            return

        code = (parse_qs(parsed.query).get("code") or [""])[0].strip()
        if not hmac.compare_digest(code, manager.code or ""):
            self._json(403, {"ok": False, "error": "导入码不正确。"})
            return
        if not manager.active:
            self._json(410, {"ok": False, "error": "题库分享已经结束，请在电脑上重新开始分享。"})
            return
        try:
            with manager.library_lock:
                payload = build_library_payload(manager.library_root)
        except LibraryError as exc:
            self._json(409, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"ok": False, "error": f"读取题库失败：{exc}"})
            return
        self._json(200, payload)

    def log_message(self, fmt, *args):  # noqa: A003
        return


class LibraryShareManager:
    def __init__(
        self,
        library_root: Path,
        *,
        default_port: int = DEFAULT_PORT,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        library_lock: threading.Lock | None = None,
    ) -> None:
        self.library_root = Path(library_root).resolve()
        self.default_port = int(default_port)
        self.ttl_seconds = max(30, int(ttl_seconds))
        self.library_lock = library_lock or threading.Lock()
        self._lock = threading.RLock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._timer: threading.Timer | None = None
        self.code = ""
        self.port = 0
        self.started_at = 0.0
        self.expires_at = 0.0

    @property
    def active(self) -> bool:
        return bool(self._server and self._thread and self._thread.is_alive() and time.time() < self.expires_at)

    def status(self) -> dict:
        with self._lock:
            active = self.active
            remaining = max(0, int(self.expires_at - time.time())) if active else 0
            return {
                "ok": True,
                "active": active,
                "port": self.port if active else 0,
                "code": self.code if active else "",
                "addresses": local_ipv4_addresses() if active else [],
                "remainingSeconds": remaining,
                "ttlSeconds": self.ttl_seconds,
            }

    def start(self) -> dict:
        with self._lock:
            if self.active:
                return self.status()
            self.stop_locked()

            # 先确认题库里确实有题目，避免平板连上后才发现为空。
            with self.library_lock:
                build_library_payload(self.library_root)

            server = None
            port = 0
            for candidate in range(self.default_port, self.default_port + 20):
                try:
                    server = ThreadingHTTPServer(("0.0.0.0", candidate), ShareHandler)
                    port = candidate
                    break
                except OSError:
                    continue
            if server is None:
                raise LibraryError(
                    f"端口 {self.default_port}-{self.default_port + 19} 都被占用，无法开始分享。"
                )

            self.code = f"{secrets.randbelow(900_000) + 100_000:06d}"
            self.port = port
            self.started_at = time.time()
            self.expires_at = self.started_at + self.ttl_seconds
            server.daemon_threads = True
            server.share_manager = self  # type: ignore[attr-defined]
            self._server = server
            self._thread = threading.Thread(target=server.serve_forever, daemon=True)
            self._thread.start()
            self._timer = threading.Timer(self.ttl_seconds, self.stop)
            self._timer.daemon = True
            self._timer.start()
            return self.status()

    def stop(self) -> dict:
        with self._lock:
            self.stop_locked()
            return self.status()

    def stop_locked(self) -> None:
        timer = self._timer
        self._timer = None
        if timer:
            timer.cancel()
        server = self._server
        self._server = None
        thread = self._thread
        self._thread = None
        self.code = ""
        self.port = 0
        self.started_at = 0.0
        self.expires_at = 0.0
        if server:
            try:
                server.shutdown()
            except Exception:  # noqa: BLE001
                pass
            try:
                server.server_close()
            except Exception:  # noqa: BLE001
                pass
        if thread and thread.is_alive() and thread is not threading.current_thread():
            try:
                thread.join(timeout=1.0)
            except Exception:  # noqa: BLE001
                pass

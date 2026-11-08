"""在局域网内通过 HTTPS 提供平板离线版安装页面。

浏览器只允许在 HTTPS（或 localhost）下注册 Service Worker 并安装 PWA。
这个脚本同时启动一个 HTTP 安装页和一个 HTTPS 应用服务：
1. 平板打开 HTTP 安装页，不会先遇到证书警告；
2. 安装包含本地 CA 和主屏幕图标的组合描述文件，并开启证书信任；
3. 打开主屏幕图标加载离线应用；
4. 安装完成后可以停止本脚本，平板断网也能继续刷题。
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import html
import io
import ipaddress
import os
import socket
import ssl
import sys
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

ROOT = Path(__file__).resolve().parent.parent
APP_ROOT = ROOT / "dist-offline"
CERT_ROOT = ROOT / "offline-certs"


def fail(message: str) -> None:
    print(f"[错误] {message}")
    raise SystemExit(1)


def require_cryptography():
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError:
        fail(
            "缺少 cryptography，无法生成本地 HTTPS 证书。\n"
            "请先运行：py -m pip install cryptography"
        )
    return x509, hashes, serialization, rsa, ExtendedKeyUsageOID, NameOID


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

    # 不需要真的联网；连接 UDP 地址可以让系统选出当前网卡地址。
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


def write_private_key(path: Path, key, serialization) -> None:
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def ensure_ca(x509, hashes, serialization, rsa, NameOID):
    CERT_ROOT.mkdir(parents=True, exist_ok=True)
    ca_key_path = CERT_ROOT / "ca.key"
    ca_cert_path = CERT_ROOT / "ca.crt"

    if ca_key_path.is_file() and ca_cert_path.is_file():
        try:
            ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
            ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
            now = dt.datetime.now(dt.timezone.utc)
            if ca_cert.not_valid_after_utc > now + dt.timedelta(days=30):
                return ca_key, ca_cert
        except (ValueError, TypeError):
            pass

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = dt.datetime.now(dt.timezone.utc)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "刷题助手局域网本地 CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Shuati Helper Local"),
        ]
    )
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    write_private_key(ca_key_path, ca_key, serialization)
    ca_cert_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    return ca_key, ca_cert


def ensure_server_cert(x509, hashes, serialization, rsa, ExtendedKeyUsageOID, NameOID, ca_key, ca_cert):
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = dt.datetime.now(dt.timezone.utc)
    hostname = socket.gethostname() or "shuati-helper"
    addresses = ["127.0.0.1", *local_ipv4_addresses()]
    san_entries = [
        x509.DNSName("localhost"),
        x509.DNSName(hostname),
        *[x509.IPAddress(ipaddress.ip_address(item)) for item in addresses],
    ]
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "刷题助手局域网安装"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Shuati Helper Local"),
        ]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.SubjectAlternativeName(san_entries),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    write_private_key(CERT_ROOT / "server.key", server_key, serialization)
    (CERT_ROOT / "server.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert


def preferred_host(host_header: str, port: int) -> str:
    host = (host_header or "").strip()
    hostname = host.rsplit(":", 1)[0].strip("[]").lower() if host else ""
    if not host or hostname in {"127.0.0.1", "localhost", "::1"}:
        addresses = local_ipv4_addresses()
        hostname = addresses[0] if addresses else "127.0.0.1"
    return f"{hostname}:{port}"


def preferred_base_url(host_header: str, port: int, scheme: str = "https") -> str:
    return f"{scheme}://{preferred_host(host_header, port)}"


def mobileconfig(
    ca_cert_path: Path,
    common_name: str,
    *,
    app_url: str = "",
    icon_path: Path | None = None,
) -> bytes:
    der = ssl.PEM_cert_to_DER_cert(ca_cert_path.read_text(encoding="ascii"))
    payload = base64.b64encode(der).decode("ascii")
    profile_uuid = str(uuid.uuid4()).upper()
    cert_uuid = str(uuid.uuid4()).upper()

    webclip = ""
    if app_url:
        webclip_uuid = str(uuid.uuid4()).upper()
        icon_xml = ""
        if icon_path and icon_path.is_file():
            icon_xml = (
                "\n      <key>Icon</key>\n"
                f"      <data>{base64.b64encode(icon_path.read_bytes()).decode('ascii')}</data>"
            )
        webclip = f"""
    <dict>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadIdentifier</key>
      <string>local.shuati.helper.webclip.{webclip_uuid}</string>
      <key>PayloadUUID</key>
      <string>{webclip_uuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadDisplayName</key>
      <string>刷题助手</string>
      <key>Label</key>
      <string>刷题助手</string>
      <key>URL</key>
      <string>{html.escape(app_url, quote=True)}</string>{icon_xml}
      <key>FullScreen</key>
      <true/>
      <key>IsRemovable</key>
      <true/>
      <key>Precomposed</key>
      <true/>
    </dict>"""

    display_name = "刷题助手安装（证书 + 主屏幕图标）" if app_url else "刷题助手局域网安装证书"
    description = (
        "安装后会在主屏幕添加刷题助手图标，并信任局域网安装服务"
        if app_url
        else "安装后可在局域网内安装刷题助手离线版"
    )
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>shuati-helper-ca.crt</string>
      <key>PayloadContent</key>
      <data>{payload}</data>
      <key>PayloadDescription</key>
      <string>用于信任刷题助手局域网安装服务</string>
      <key>PayloadDisplayName</key>
      <string>刷题助手局域网 CA</string>
      <key>PayloadIdentifier</key>
      <string>local.shuati.helper.ca.{cert_uuid}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>{cert_uuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>{webclip}
  </array>
  <key>PayloadDescription</key>
  <string>{html.escape(description, quote=True)}</string>
  <key>PayloadDisplayName</key>
  <string>{html.escape(display_name, quote=True)}</string>
  <key>PayloadIdentifier</key>
  <string>local.shuati.helper.profile.{profile_uuid}</string>
  <key>PayloadOrganization</key>
  <string>Shuati Helper Local</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{profile_uuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"""
    return xml.encode("utf-8")


def qr_data_url(url: str) -> str:
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        return ""
    image = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage)
    buffer = io.BytesIO()
    image.save(buffer)
    return "data:image/svg+xml;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def write_qr_page(install_url: str) -> Path:
    qr = qr_data_url(install_url)
    qr_html = (
        f'<img src="{qr}" alt="安装二维码">'
        if qr
        else '<p class="fallback">未安装 qrcode 组件，请手动在 iPad 输入下方地址。</p>'
    )
    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>刷题助手 · 安装二维码</title>
<style>
  :root {{ color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }}
  body {{ max-width: 620px; margin: 0 auto; padding: 28px 20px 50px; text-align: center; line-height: 1.7; }}
  h1 {{ font-size: 25px; margin-bottom: 6px; }}
  .qr {{ display: inline-block; margin: 18px auto; padding: 14px; background: #fff; border-radius: 16px; }}
  .qr img {{ display: block; width: 260px; height: 260px; }}
  code {{ background: rgba(127,127,127,.12); padding: 3px 7px; border-radius: 5px; word-break: break-all; }}
  .muted {{ color: #656d76; font-size: 14px; }}
  .fallback {{ color: #b35900; }}
</style>
</head>
<body>
  <h1>用 iPad 扫描二维码</h1>
  <p class="muted">iPad 相机扫码后会打开安装页；然后点击「安装刷题助手」。</p>
  <div class="qr">{qr_html}</div>
  <p>也可以手动打开：<br><code>{html.escape(install_url)}</code></p>
  <p class="muted">安装描述文件后，还要到「设置 → 通用 → 关于本机 → 证书信任设置」开启完全信任。</p>
</body>
</html>
"""
    path = CERT_ROOT / "安装二维码.html"
    path.write_text(page, encoding="utf-8")
    return path


def install_page(host_header: str, install_port: int, https_port: int) -> bytes:
    install_base = preferred_base_url(host_header, install_port, "http")
    app_base = preferred_base_url(host_header, https_port, "https")
    display_ip = html.escape(urlparse_base_host(install_base))
    install_url = f"{install_base}/install"
    app_url = f"{app_base}/"
    qr = qr_data_url(install_url)
    qr_card = (
        f'<div class="qr-card"><img src="{qr}" alt="扫码打开安装页"><p>iPad 相机扫码打开安装页</p></div>'
        if qr
        else ""
    )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安装刷题助手离线版</title>
<style>
  :root {{ color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }}
  body {{ max-width: 720px; margin: 0 auto; padding: 28px 20px 60px; line-height: 1.7; }}
  h1 {{ font-size: 26px; margin-bottom: 8px; }}
  h2 {{ font-size: 18px; margin-top: 28px; }}
  .card {{ padding: 16px 18px; border: 1px solid #d0d7de; border-radius: 12px; margin: 16px 0; }}
  .btn {{ display: inline-block; padding: 11px 18px; color: #fff; background: #0969da; border-radius: 9px; text-decoration: none; font-weight: 600; }}
  .btn.secondary {{ color: #0969da; background: transparent; border: 1px solid #0969da; }}
  code {{ background: rgba(127,127,127,.12); padding: 2px 6px; border-radius: 5px; }}
  ol li {{ margin: 8px 0; }}
  .muted {{ color: #656d76; font-size: 14px; }}
  .qr-card {{ display: flex; align-items: center; gap: 14px; padding: 14px; margin: 16px 0; border: 1px solid #d0d7de; border-radius: 12px; }}
  .qr-card img {{ width: 132px; height: 132px; background: #fff; border-radius: 8px; }}
  .qr-card p {{ margin: 0; color: #656d76; font-size: 14px; }}
</style>
</head>
<body>
  <h1>刷题助手 · 离线版安装</h1>
  <p class="muted">安装页：<code>{html.escape(install_url)}</code></p>
  <p class="muted">应用地址：<code>{html.escape(app_url)}</code></p>
  {qr_card}
  <div class="card">
    <strong>iPad / iPhone：一键安装</strong>
    <p>点击按钮安装描述文件。里面同时包含局域网证书和刷题助手主屏幕图标。</p>
    <p>
      <a class="btn" href="/app.mobileconfig">安装刷题助手</a>
      &nbsp;
      <a class="btn secondary" href="/ca.mobileconfig">仅安装证书（备用）</a>
    </p>
    <p class="muted">安装后仍需完成下一步的“证书完全信任”，这是 iOS 的安全要求。证书只用于这台电脑的局域网地址，不包含题库内容。</p>
  </div>
  <div class="card">
    <strong>第二步：信任证书</strong>
    <ol>
      <li><b>iPad / iPhone：</b>打开「设置 → 已下载描述文件 → 安装」，再进入「设置 → 通用 → 关于本机 → 证书信任设置」，打开「刷题助手局域网本地 CA」的完全信任。</li>
      <li><b>Android：</b>点击下方的 Android 证书按钮，在「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」中安装。不同品牌的菜单名称可能略有不同。</li>
    </ol>
    <p><a class="btn secondary" href="/ca.crt">Android 下载 CA 证书</a></p>
  </div>
  <div class="card">
    <strong>第三步：打开主屏幕图标</strong>
    <p>描述文件通常会自动添加「刷题助手」图标。如果主屏幕没有出现图标：</p>
    <ol>
      <li>用 Safari 打开 <code>{html.escape(app_url)}</code>。</li>
      <li>点击分享按钮 →「添加到主屏幕」。</li>
    </ol>
    <p>打开图标后等待页面完整加载一次；之后可以关闭电脑上的安装服务并断网使用。</p>
    <p class="muted">Android 用户：Chrome 菜单 →「安装应用」或「添加到主屏幕」。</p>
  </div>
  <p class="muted">电脑端导出的题库文件：在平板打开「我的题库 → 导入题库 → 选择 .json 文件」。</p>
  <p class="muted">安装页地址：{display_ip}</p>
</body>
</html>
""".encode("utf-8")


def urlparse_base_host(base: str) -> str:
    """从 https://host:port 中取出 host:port，用于显示。"""
    return base.replace("https://", "", 1).rstrip("/")


class LanHandler(SimpleHTTPRequestHandler):
    server_version = "ShuatiHelperLAN/1.0"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".crt": "application/x-x509-ca-cert",
        ".md": "text/plain; charset=utf-8",
    }

    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self):  # noqa: N802
        if self.path in {"/install", "/install/", "/install.html"}:
            body = install_page(
                self.headers.get("Host", ""),
                self.server.install_port,
                self.server.server_port,
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/ca.crt":
            data = (CERT_ROOT / "ca.crt").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="shuati-helper-ca.crt"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path == "/ca.mobileconfig":
            data = mobileconfig(CERT_ROOT / "ca.crt", "刷题助手局域网本地 CA")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-apple-aspen-config")
            self.send_header("Content-Disposition", 'attachment; filename="shuati-helper-ca.mobileconfig"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path == "/app.mobileconfig":
            base = preferred_base_url(self.headers.get("Host", ""), self.server.server_port)
            data = mobileconfig(
                CERT_ROOT / "ca.crt",
                "刷题助手局域网本地 CA",
                app_url=f"{base}/",
                icon_path=APP_ROOT / "icons" / "icon-192.png",
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/x-apple-aspen-config")
            self.send_header("Content-Disposition", 'attachment; filename="shuati-helper-install.mobileconfig"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def end_headers(self):
        if self.path in {"/", "/index.html", "/sw.js"}:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):  # noqa: A003
        return


class InstallHandler(BaseHTTPRequestHandler):
    """独立的 HTTP 安装页，避免在信任证书前被 Safari 拦截。"""

    server_version = "ShuatiHelperInstall/1.0"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mobileconfig": "application/x-apple-aspen-config",
        ".crt": "application/x-x509-ca-cert",
    }

    def _send(self, status: int, content_type: str, data: bytes, filename: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        host_header = self.headers.get("Host", "")
        if parsed.path in {"/", "/install", "/install/", "/install.html"}:
            body = install_page(host_header, self.server.install_port, self.server.https_port)
            self._send(200, "text/html; charset=utf-8", body)
            return
        if parsed.path == "/app.mobileconfig":
            app_base = preferred_base_url(host_header, self.server.https_port, "https")
            data = mobileconfig(
                CERT_ROOT / "ca.crt",
                "刷题助手局域网本地 CA",
                app_url=f"{app_base}/",
                icon_path=APP_ROOT / "icons" / "icon-192.png",
            )
            self._send(
                200,
                "application/x-apple-aspen-config",
                data,
                "shuati-helper-install.mobileconfig",
            )
            return
        if parsed.path == "/ca.mobileconfig":
            data = mobileconfig(CERT_ROOT / "ca.crt", "刷题助手局域网本地 CA")
            self._send(
                200,
                "application/x-apple-aspen-config",
                data,
                "shuati-helper-ca.mobileconfig",
            )
            return
        if parsed.path == "/ca.crt":
            data = (CERT_ROOT / "ca.crt").read_bytes()
            self._send(200, "application/x-x509-ca-cert", data, "shuati-helper-ca.crt")
            return
        if parsed.path == "/api/health":
            self._send(
                200,
                "application/json; charset=utf-8",
                b'{"ok":true,"service":"shuati-installer"}',
            )
            return
        self._send(404, "application/json; charset=utf-8", b'{"ok":false,"error":"not found"}')

    def log_message(self, fmt, *args):  # noqa: A003
        return


def main() -> int:
    global CERT_ROOT
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, OSError):
        pass
    parser = argparse.ArgumentParser(description="局域网 HTTPS 安装刷题助手离线版")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--install-port", type=int, default=8080, help="HTTP 安装页端口")
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--cert-dir", default=str(CERT_ROOT))
    parser.add_argument("--no-qr-window", action="store_true", help="不自动打开电脑上的二维码页面")
    args = parser.parse_args()

    CERT_ROOT = Path(args.cert_dir).expanduser().resolve()

    if not (APP_ROOT / "index.html").is_file():
        fail("找不到 dist-offline/index.html。请先运行「pwa/构建离线版.bat」或 `py build_offline.py`。")

    x509, hashes, serialization, rsa, ExtendedKeyUsageOID, NameOID = require_cryptography()
    ca_key, ca_cert = ensure_ca(x509, hashes, serialization, rsa, NameOID)
    ensure_server_cert(
        x509, hashes, serialization, rsa, ExtendedKeyUsageOID, NameOID, ca_key, ca_cert
    )

    server = ThreadingHTTPServer((args.bind, args.port), lambda *a, **kw: LanHandler(*a, directory=str(APP_ROOT), **kw))
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT_ROOT / "server.crt", CERT_ROOT / "server.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)

    install_server = None
    for candidate in range(args.install_port, args.install_port + 20):
        try:
            install_server = ThreadingHTTPServer((args.bind, candidate), InstallHandler)
            break
        except OSError:
            continue
    if install_server is None:
        server.server_close()
        fail(f"端口 {args.install_port}-{args.install_port + 19} 都被占用，无法启动安装页。")
    install_server.daemon_threads = True
    install_server.https_port = args.port
    install_server.install_port = install_server.server_port
    server.install_port = install_server.install_port
    threading.Thread(target=install_server.serve_forever, daemon=True).start()

    addresses = local_ipv4_addresses()
    print("")
    print("  局域网安装服务已启动")
    print("")
    if addresses:
        for index, address in enumerate(addresses):
            print(f"  平板安装页：http://{address}:{install_server.install_port}/install")
            print(f"  应用地址：  https://{address}:{args.port}/")
            if index == 0 and len(addresses) > 1:
                print("  （如果第一个地址打不开，请尝试下面列出的其他地址）")
    else:
        print("  [提示] 没有检测到局域网 IPv4 地址，请检查电脑是否已连接 Wi-Fi/网线。")

    qr_host = f"{addresses[0]}:{install_server.install_port}" if addresses else f"127.0.0.1:{install_server.install_port}"
    qr_install_url = f"http://{qr_host}/install"
    try:
        qr_path = write_qr_page(qr_install_url)
        print("")
        print(f"  二维码页面：{qr_path}")
        if not args.no_qr_window:
            webbrowser.open(qr_path.as_uri())
    except Exception as exc:  # noqa: BLE001
        print(f"  [提示] 二维码页面生成失败：{exc}")

    print("")
    print("  用 iPad 相机扫描二维码，或在 Safari 打开上面的 /install 地址。")
    print("  安装「证书 + 主屏幕图标」描述文件后，开启证书完全信任。")
    print("  安装完成并缓存离线应用后，可以关闭此窗口。")
    print("  证书目录：", CERT_ROOT)
    print("")
    print("  按 Ctrl+C 停止服务。")
    print("")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止局域网安装服务。")
    finally:
        try:
            install_server.shutdown()
        except Exception:  # noqa: BLE001
            pass
        server.server_close()
        install_server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

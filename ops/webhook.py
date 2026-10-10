"""Loopback-only GitHub receiver; expose only this service through an HTTPS tunnel."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import subprocess
import threading
from common import config, read
from webhook_queue import queue_delivery, queue_file

MAX_BODY = 1024 * 1024


def delivery(c, secret, headers, body):
    signature = headers.get('X-Hub-Signature-256', '')
    expected = 'sha256='+hmac.new(secret, body, hashlib.sha256).hexdigest()
    if not re.fullmatch(r'sha256=[a-f0-9]{64}', signature) or not hmac.compare_digest(signature, expected):
        return 401, False
    ident = headers.get('X-GitHub-Delivery', '')
    if not re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', ident):
        return 400, False
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError):
        return 400, False
    if not isinstance(payload, dict) or not isinstance(payload.get('repository'), dict):
        return 400, False
    repo = payload['repository'].get('id')
    if type(repo) is not int or repo != c['webhook_repository_id']:
        return 403, False
    event = headers.get('X-GitHub-Event')
    if event == 'ping':
        return 200, False
    if event != 'push' or payload.get('ref') != 'refs/heads/'+c['branch'] or payload.get('deleted'):
        return 202, False
    after = payload.get('after')
    if not isinstance(after, str) or not re.fullmatch(r'[a-f0-9]{40}', after) or after == '0'*40:
        return 400, False
    return 202, queue_delivery(c, ident)


def handler(c, secret, wake):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'InklingWebhook'
        sys_version = ''

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_):
            pass  # Never journal payloads, headers or request paths.

        def reply(self, status):
            self.send_response(status)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()

        def do_GET(self):
            self.reply(204 if self.path == '/health' else 404)

        def do_POST(self):
            if self.path != '/github':
                return self.reply(404)
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,8}', lengths[0]):
                return self.reply(400)
            size = int(lengths[0])
            if not 0 < size <= MAX_BODY:
                return self.reply(413)
            if self.headers.get_content_type() != 'application/json':
                return self.reply(415)
            try:
                body = self.rfile.read(size)
                if len(body) != size:
                    return self.reply(400)
                status, queued = delivery(c, secret, self.headers, body)
                if queued:
                    wake.set()
                self.reply(status)
            except (TimeoutError, OSError, ValueError):
                self.reply(503)
    return Handler


def dispatch(c, wake, stop):
    delay = 2
    while not stop.is_set():
        wake.wait(delay)
        wake.clear()
        if stop.is_set():
            break
        try:
            if not read(queue_file(c), {}).get('pending'):
                delay = 30
                continue
            # Wait for an existing update too. The checkpoint preserves events arriving after its fetch.
            result = subprocess.run(['systemctl', '--user', 'start', 'inkling-update.service'],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2800)
            delay = 30 if result.returncode == 0 else min(max(delay * 2, 60), 300)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            delay = min(max(delay * 2, 60), 300)
            print('Webhook update deferred; durable queue retained.', flush=True)


def main():
    c = config()
    if c.get('role') != 'pi' or type(c.get('webhook_repository_id')) is not int:
        raise ValueError('Configure the Pi repository identity first')
    secret = Path(c['webhook_secret']).read_bytes().strip()
    if len(secret) < 32:
        raise ValueError('Webhook signing secret is too short')
    wake, stop = threading.Event(), threading.Event()
    worker = threading.Thread(target=dispatch, args=(c, wake, stop), daemon=True)
    server = HTTPServer(('127.0.0.1', int(c.get('webhook_port', 8789))), handler(c, secret, wake))
    worker.start()
    print('Signed webhook receiver ready on loopback.', flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        wake.set()
        server.server_close()


if __name__ == '__main__':
    main()

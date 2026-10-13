"""Offline routing and isolation checks; no real assistant, capture, deployment or messages."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
import threading
import unittest
from webhook import handler, ReceiverServer


class MicProxy(unittest.TestCase):
    def setUp(self):
        self.seen = []
        seen = self.seen

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                seen.append((self.command, self.path, self.headers.get('Authorization'), b''))
                data = json.dumps({'path': self.path}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                seen.append((self.command, self.path, self.headers.get('Origin'), body))
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.c = {'webhook_mic_port': self.upstream.server_port}
        self.receiver = ReceiverServer(('127.0.0.1', 0), handler(self.c, b'x'*64, threading.Event()))
        for server in (self.upstream, self.receiver):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        self.auth = {'Authorization': 'Bearer '+'a'*32}

    def request(self, path, method='GET', body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.receiver.server_port, timeout=2)
        self.addCleanup(connection.close)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def test_page_redirect_assets_and_path_stripping(self):
        status, headers, _ = self.request('/mic')
        self.assertEqual(status, 308)
        self.assertEqual(headers['Location'], '/mic/')
        self.assertEqual(self.request('/mic/')[0], 200)
        self.assertEqual(self.request('/mic/microphone-recorder.js')[0], 200)
        status, headers, body = self.request('/mic/status', headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['path'], '/status')
        self.assertEqual(headers['Permissions-Policy'], 'microphone=(self), camera=()')
        self.assertEqual(self.seen[-1][2], self.auth['Authorization'])

    def test_private_routes_require_bearer_and_other_services_not_proxied(self):
        for path in ('/mic/status', '/mic/audio?id=fixture', '/mic/input'):
            self.assertEqual(self.request(path)[0], 403 if not path.endswith('/input') else 404)
        for path in ('/mic/../health', '/mic/browser', '/mic/connect/google', '/mic//status', '/status'):
            self.assertEqual(self.request(path, headers=self.auth)[0], 404)
        self.assertEqual(self.seen, [])

    def test_upload_query_origin_and_body_preserved(self):
        status, _, _ = self.request('/mic/input?id=fixture', 'POST', b'fixture',
                                    {**self.auth, 'Origin': 'https://example.org', 'Content-Type': 'audio/wav'})
        self.assertEqual(status, 200)
        self.assertEqual(self.seen[-1], ('POST', '/input?id=fixture', 'https://example.org', b'fixture'))

    def test_body_limits_and_default_disabled(self):
        self.assertEqual(self.request('/mic/input', 'POST', headers={**self.auth,'Content-Length':'640045'})[0], 413)
        self.assertEqual(self.request('/mic/hold', 'POST', b'x', self.auth)[0], 413)
        self.assertEqual(self.seen, [])
        self.c.pop('webhook_mic_port')
        self.assertEqual(self.request('/mic/')[0], 404)

    def test_webhook_and_health_still_separate(self):
        self.assertEqual(self.request('/health')[0], 204)
        self.assertEqual(self.request('/github', 'POST', b'{}', {'Content-Type':'application/json'})[0], 401)
        self.assertEqual(self.seen, [])


if __name__ == '__main__':
    unittest.main()

"""Optional fixed-path proxy to the private microphone controller. Never proxy arbitrary hosts/routes."""
import http.client
import re
from urllib.parse import urlsplit

GET = {'/', '/microphone-device.js', '/microphone-recorder.js', '/microphone-speaker.js', '/status', '/audio', '/reply-audio'}
POST = {'/hold', '/held', '/done', '/cancel', '/compare', '/listen', '/input', '/chunk'}
PUBLIC = {'/', '/microphone-device.js', '/microphone-recorder.js', '/microphone-speaker.js'}
MAX_AUDIO = 640044
RESPONSE_HEADERS = {'content-type', 'cache-control', 'referrer-policy', 'x-content-type-options',
                    'x-frame-options', 'content-security-policy'}


def proxy(handler, configuration):
    """Return False for non-mic paths; the normal signed-webhook handler owns those."""
    target = urlsplit(handler.path)
    if target.path != '/mic' and not target.path.startswith('/mic/'):
        return False
    port = configuration.get('webhook_mic_port')
    if type(port) is not int or not 1024 <= port <= 65535:
        handler.reply(404)
        return True
    if target.path == '/mic' and handler.command == 'GET':
        handler.send_response(308)
        handler.send_header('Location', '/mic/')
        handler.send_header('Content-Length', '0')
        handler.send_header('Cache-Control', 'no-store')
        handler.end_headers()
        return True
    path = target.path[4:]
    allowed = GET if handler.command == 'GET' else POST if handler.command == 'POST' else set()
    if path not in allowed or len(handler.path) > 2048:
        handler.reply(404)
        return True
    authorization = handler.headers.get('Authorization', '')
    if path not in PUBLIC and not re.fullmatch(r'Bearer [a-zA-Z0-9_-]{32}', authorization):
        handler.reply(403)
        return True
    lengths = handler.headers.get_all('Content-Length', [])
    if handler.headers.get('Transfer-Encoding') or len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]{1,7}', lengths[0])):
        handler.reply(400)
        return True
    size = int(lengths[0]) if lengths else 0
    if size > (MAX_AUDIO if path == '/input' else 16000 if path == '/chunk' else 0):
        handler.reply(413)
        return True
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15 if path == '/reply-audio' else 10)
    started = False
    try:
        body = handler.rfile.read(size) if size else None
        if body is not None and len(body) != size:
            handler.reply(400)
            return True
        headers = {'Content-Length': str(size)}
        for key in ('Authorization', 'Origin', 'Content-Type', 'X-Inkling-Offset'):
            if key in handler.headers:
                headers[key] = handler.headers[key]
        connection.request(handler.command, path+('?' + target.query if target.query else ''), body=body, headers=headers)
        response = connection.getresponse()
        if path == '/reply-audio' and response.status == 200:
            handler.send_response(200)
            for key, value in response.getheaders():
                if key.lower() in RESPONSE_HEADERS:
                    handler.send_header(key, value)
            handler.send_header('Connection', 'close')
            handler.end_headers()
            handler.close_connection = True
            started = True
            total = 0
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > 2200036:
                    break
                handler.wfile.write(chunk)
                handler.wfile.flush()
            return True
        maximum = MAX_AUDIO if path == '/audio' else 256000
        content = response.read(maximum+1)
        if len(content) > maximum:
            handler.reply(502)
            return True
        handler.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() in RESPONSE_HEADERS:
                handler.send_header(key, value)
        handler.send_header('Permissions-Policy', 'microphone=(self), camera=()')
        handler.send_header('Content-Length', str(len(content)))
        handler.send_header('Connection', 'close')
        handler.end_headers()
        handler.wfile.write(content)
    except (OSError, http.client.HTTPException):
        if not started:
            handler.reply(502)
        handler.close_connection = True
    finally:
        connection.close()
    return True

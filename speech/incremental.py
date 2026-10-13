"""Bounded in-memory incremental recognition. Drafts never become assistant instructions."""
from dataclasses import dataclass, field
import threading
import time
import unicodedata
import uuid

RATE = 16000
MAX_BYTES = RATE * 2 * 20


class SessionError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


@dataclass
class Session:
    id: str
    audio: bytearray = field(default_factory=bytearray)
    state: str = 'capturing'
    revision: int = 0
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    finished: float = 0
    final_size: int = 0
    covered: int = 0
    previews: int = 0
    draft: str = ''
    stable: str = ''
    result: dict | None = None
    error: str | None = None


def agreement(previous, current):
    """Display stability only. Final decoding remains authoritative and can change all words."""
    left, right = previous.split(), current.split()
    n = 0
    for a, b in zip(left, right):
        if unicodedata.normalize('NFC', a) != unicodedata.normalize('NFC', b):
            break
        n += 1
    # Leave a small provisional tail; agreement is not a confidence score.
    return ' '.join(right[:max(0,n-2)])


class Sessions:
    def __init__(self, decode, validate, *, clock=time.monotonic, start=True, fatal=None):
        self.decode, self.validate, self.clock = decode, validate, clock
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.session = None
        self.active = False
        self.cooldown = 0
        self.closed = False
        self.fatal = fatal
        self.native_started = 0
        self.restarting = False
        if start:
            threading.Thread(target=self.worker, daemon=True).start()
            threading.Thread(target=self.janitor, daemon=True).start()

    def expire(self):
        session, now = self.session, self.clock()
        if not session:
            return
        if session.state == 'capturing' and (now-session.touched > 10 or now-session.created > 30):
            self.discard(session, 'expired')
        elif session.state == 'finishing' and now-session.finished > 190:
            self.discard(session, 'expired')
        elif session.state in ('done','cancelled','expired','failed') and now-session.touched > 60 and not self.active:
            self.session = None

    def discard(self, session, state):
        session.state = state
        session.audio[:] = b'\0'*len(session.audio)
        session.audio.clear()
        session.draft = session.stable = ''
        session.result = None
        session.touched = self.clock()
        session.revision += 1

    def create(self):
        with self.changed:
            self.expire()
            if self.active or self.clock() < self.cooldown or (self.session and self.session.state in ('capturing','finishing')):
                raise SessionError(429,'busy')
            now = self.clock()
            self.session = Session(uuid.uuid4().hex, created=now, touched=now)
            return self.snapshot(self.session)

    def get(self, ident):
        self.expire()
        if not self.session or self.session.id != ident:
            raise SessionError(410,'expired')
        return self.session

    def append(self, ident, offset, audio):
        with self.changed:
            session = self.get(ident)
            if session.state != 'capturing':
                raise SessionError(409,'sealed')
            if not audio or len(audio)%2 or len(audio)>32000 or offset<0 or offset%2:
                raise SessionError(400,'invalid_audio')
            if offset < len(session.audio):
                if offset+len(audio)>len(session.audio) or session.audio[offset:offset+len(audio)] != audio:
                    raise SessionError(409,'conflict')
            elif offset == len(session.audio) and offset+len(audio)<=MAX_BYTES:
                session.audio.extend(audio)
            else:
                raise SessionError(409,'gap_or_limit')
            session.touched = self.clock()
            session.revision += 1
            self.changed.notify_all()
            return self.snapshot(session)

    def finish(self, ident, size):
        with self.changed:
            session = self.get(ident)
            if size != (session.final_size or len(session.audio)) or not 9600 <= size <= MAX_BYTES:
                raise SessionError(409,'incomplete')
            if session.state == 'capturing':
                session.state = 'finishing'
                session.final_size = size
                session.finished = session.touched = self.clock()
                session.revision += 1
                self.changed.notify_all()
            elif session.state not in ('finishing','done'):
                raise SessionError(409,'unavailable')
            return self.snapshot(session)

    def cancel(self, ident):
        with self.changed:
            session = self.get(ident)
            self.discard(session, 'cancelled')
            self.changed.notify_all()
            return self.snapshot(session)

    def status(self, ident):
        with self.lock:
            return self.snapshot(self.get(ident))

    def snapshot(self, session):
        return {'id':session.id, 'state':session.state, 'revision':session.revision,
                'receivedBytes':session.final_size or len(session.audio),'decodedBytes':session.covered,
                'draft':session.draft,'stable':session.stable,'result':session.result,
                'error':session.error,'nativeBusy':self.active}

    def step(self):
        """One worker operation, also directly exercised by deterministic fixtures."""
        with self.lock:
            self.expire()
            session = self.session
            if self.active or not session or session.state not in ('capturing','finishing'):
                return False
            final = session.state == 'finishing'
            if not final and (len(session.audio)<128000 or len(session.audio)-session.covered<128000 or session.previews>=4):
                return False
            pcm = bytes(session.audio)
            self.active = True
            self.native_started = self.clock()
        try:
            decoded = self.decode(pcm)
            # A final full-recording pass avoids stitching errors and changed numbers/negations.
            result = self.validate(decoded, pcm) if final else None
            text = decoded.get('text','').strip()
            if not text or len(text)>16000:
                raise ValueError('unusable')
            with self.lock:
                self.expire()
                if self.session is not session or session.state not in ('capturing','finishing'):
                    return True
                session.stable = agreement(session.draft,text)
                session.draft = text
                session.covered = len(pcm)
                session.previews += not final
                session.revision += 1
                if final:
                    session.result = result
                    session.state = 'done'
                    session.audio[:] = b'\0'*len(session.audio)
                    session.audio.clear()
                    # Keep the count for idempotent finish calls after raw audio is discarded.
                    session.touched = self.clock()
        except Exception:
            with self.lock:
                self.cooldown = self.clock()+60
                if self.session is session and session.state in ('capturing','finishing'):
                    self.discard(session,'failed')
                    session.error = 'unavailable'
        finally:
            with self.changed:
                self.active = False
                self.changed.notify_all()
        return True

    def worker(self):
        while not self.closed:
            if not self.step():
                with self.changed:
                    self.changed.wait(.2)

    def watchdog(self):
        with self.lock:
            restart = bool(self.fatal and self.active and self.clock()-self.native_started>195 and not self.restarting)
            if restart:
                self.restarting = True
        if restart:
            self.fatal()  # Supervised service restart, never a model-supplied command.

    def janitor(self):
        while not self.closed:
            with self.lock:
                self.expire()
            self.watchdog()
            time.sleep(.5)

    def close(self):
        with self.changed:
            self.closed = True
            if self.session:
                self.discard(self.session,'cancelled')
            self.changed.notify_all()

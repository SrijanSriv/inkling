"""Durable, coalesced update hints. Payloads never become commands or deployment inputs."""
from contextlib import contextmanager
import datetime as dt
from pathlib import Path
from common import atomic, lock, read


def queue_file(c):
    return Path(c['state'])/'webhook-queue.json'


def queue_delivery(c, delivery):
    with lock(Path(c['state'])/'webhook-queue.lock', blocking=True):
        state = read(queue_file(c), {})
        seen = state.get('deliveries', [])
        if delivery in seen:
            return False
        state.update(pending=delivery, receivedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                     deliveries=[*seen, delivery][-1000:])
        atomic(queue_file(c), state)
        return True


@contextmanager
def delivery_checkpoint(c):
    # Capture before fetch. A delivery arriving during deployment must get another fetch.
    with lock(Path(c['state'])/'webhook-queue.lock', blocking=True):
        captured = read(queue_file(c), {}).get('pending')
    yield
    if captured:
        with lock(Path(c['state'])/'webhook-queue.lock', blocking=True):
            state = read(queue_file(c), {})
            if state.get('pending') == captured:
                state.update(pending=None, acknowledgedAt=dt.datetime.now(dt.timezone.utc).isoformat())
                atomic(queue_file(c), state)

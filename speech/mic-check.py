"""Measure a named PipeWire mic without saving, transcribing or forwarding audio."""
import argparse
import array
import json
import math
import os
import selectors
import subprocess
import sys
import time

RATE = 16000


class Levels:
    def __init__(self):
        self.count = self.nonzero = self.clipped = self.total = self.energy = self.peak = 0

    def add(self, pcm):
        samples = array.array('h', pcm)
        if sys.byteorder != 'little':
            samples.byteswap()
        for value in samples:
            self.count += 1
            self.nonzero += value != 0
            self.clipped += abs(value) >= 32700
            self.total += value
            self.energy += value * value
            self.peak = max(self.peak, abs(value))

    def report(self):
        mean = self.total / max(1, self.count)
        rms = math.sqrt(self.energy / max(1, self.count))
        ac_rms = math.sqrt(max(0, self.energy / max(1, self.count) - mean * mean))
        db = lambda value: round(20 * math.log10(value / 32768), 1) if value > 0 else None
        return {'secondsCaptured': round(self.count / RATE, 2), 'samples': self.count,
                'signal': 'no-data' if not self.count else 'all-zero' if not self.nonzero else 'constant' if ac_rms == 0 else 'present',
                'peakDbfs': db(self.peak), 'rmsDbfs': db(rms), 'acRmsDbfs': db(ac_rms),
                'clippedPercent': round(100 * self.clipped / max(1, self.count), 3),
                'audioSaved': False, 'transcribed': False}


def check(target, seconds, live=False):
    process = subprocess.Popen(['pw-record', '--raw', '--target', target, '--rate', str(RATE),
                                '--channels', '1', '--format', 's16', '-'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    levels, tail = Levels(), b''
    start = last = time.monotonic()
    outcome = 'completed'
    try:
        while time.monotonic() - start < seconds:
            if not selector.select(min(2, max(.01, seconds - (time.monotonic() - start)))):
                if time.monotonic() - last >= 2:
                    outcome = 'capture-stalled'
                    break
                continue
            raw = os.read(process.stdout.fileno(), 8192)
            if not raw:
                outcome = 'capture-ended'
                break
            last = time.monotonic()
            raw = tail + raw
            size = len(raw) // 2 * 2
            levels.add(raw[:size])
            tail = raw[size:]
            if live:
                print(json.dumps(levels.report()), flush=True)
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        process.stdout.close()
    return {**levels.report(), 'capture': outcome, 'elapsedSeconds': round(time.monotonic() - start, 2)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, help='Stable PipeWire node.name, not a numeric node id or a monitor source.')
    parser.add_argument('--seconds', type=int, default=8, choices=range(2, 31), metavar='2..30')
    parser.add_argument('--live', action='store_true', help='Show levels while capturing; never prints speech.')
    args = parser.parse_args()
    try:
        result = check(args.target, args.seconds, args.live)
        print(json.dumps(result), flush=True)
        sys.exit(0 if result['capture'] == 'completed' and result['signal'] == 'present' else 2)
    except (OSError, subprocess.SubprocessError):
        print(json.dumps({'capture': 'unavailable', 'audioSaved': False, 'transcribed': False}))
        sys.exit(2)

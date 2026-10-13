"""Conservative coverage warnings, not speech recognition or an accuracy score."""
import array
import io
import math
import wave


def coverage_warning(result, sound, text):
    with wave.open(io.BytesIO(sound), 'rb') as audio:
        rate = audio.getframerate()
        samples = array.array('h', audio.readframes(audio.getnframes()))
    duration = len(samples) / rate

    def active_seconds(start, end):
        section = samples[max(0, int(start * rate)):min(len(samples), int(end * rate))]
        step = rate // 4
        return sum(len(chunk) / rate for i in range(0, len(section), step)
                   if (chunk := section[i:i+step]) and math.sqrt(sum(x*x for x in chunk) / len(chunk)) > 100)

    # A one-word result can carry a full-duration timestamp. Inspect output density separately.
    if len(text.split()) <= 2 and active_seconds(0, duration) >= 3:
        return 'Very little text for substantial audio; the transcript may be incomplete.'
    spans = [s.get('offsets', {}) for s in result.get('transcription', []) if s.get('text', '').strip()]
    spans = [(s.get('from'), s.get('to')) for s in spans]
    if not spans or any(not isinstance(a, (int, float)) or not isinstance(b, (int, float))
                        or not math.isfinite(a) or not math.isfinite(b)
                        or not 0 <= a <= b or a > duration * 1000 + 1000 for a, b in spans):
        return 'Decoder coverage could not be checked; verify the whole recording.'
    # Whisper can timestamp the entire padded 30-second window for a shorter clip.
    first, last = min(a for a, _ in spans) / 1000, min(duration, max(b for _, b in spans) / 1000)
    if first > 1.5 and active_seconds(0, first - .25) >= 1:
        return 'Audible activity before the first decoded segment; check for a missing beginning.'
    if duration - last > 1.5 and active_seconds(last + .25, duration) >= 1:
        return 'Audible activity after the last decoded segment; check for a missing ending.'
    return None

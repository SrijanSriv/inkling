# Curious waiting acknowledgement

`curious-waiting.wav` is synthetic speech generated locally with Kokoro-82M's `af_bella` voice from
"Hmm…" and "Let's see?". It contains no microphone recording or personal conversation.

The active voiced hum and the final vowel were lengthened with FFmpeg's pitch-preserving `atempo` filter;
the start transient and excess silence were trimmed. Short fades and a 160 ms pause join the parts.
The phrase's question intonation is retained. Duration: 2.143 seconds, mono PCM16 at 24 kHz.

Preparation parameters for the generated source samples: hum 0.43-0.66 s at tempo factors 0.5, 0.5, 0.88;
phrase prefix 0.38-0.76 s; final vowel 0.76-0.96 s at factors 0.5, 0.667; phrase tail 0.96-1.03 s.
These offsets apply to those particular synthetic samples, not arbitrary speech.

This optional clip is selected through `INKLING_MIC_SPEECH_FILLER_FILE`. Playback attenuates it to 45%
amplitude; it starts one second after physical mute and can be interrupted by unmute or the real answer.
FFmpeg is only a preparation tool, not a new runtime dependency. Listening feedback determines whether
the delivery sounds natural; duration and waveform checks do not establish that.

"""Optional local CTranslate2 backend; uses an explicit local checkpoint, never downloads in the service."""
import logging


class FasterBackend:
    def __init__(self, model):
        from faster_whisper import WhisperModel
        logging.getLogger('faster_whisper').setLevel(logging.CRITICAL)
        self.model = WhisperModel(model, device='cuda', compute_type='int8_float32', cpu_threads=2,
                                  num_workers=1, local_files_only=True)

    def decode(self, pcm, language, hint):
        import numpy as np
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32)/32768
        segments, _ = self.model.transcribe(samples, language=None if language=='auto' else language,
            task='transcribe', beam_size=5, temperature=0, condition_on_previous_text=False,
            initial_prompt=hint, word_timestamps=True, vad_filter=False)
        segments = list(segments)
        return {'engine':'faster-whisper', 'text':' '.join(segment.text.strip() for segment in segments), 'segments':[
            {'text':segment.text, 'start':segment.start, 'end':segment.end,
             'avg_logprob':segment.avg_logprob, 'no_speech_prob':segment.no_speech_prob,
             'words':[{'word':word.word,'start':word.start,'end':word.end} for word in segment.words or []]}
            for segment in segments]}

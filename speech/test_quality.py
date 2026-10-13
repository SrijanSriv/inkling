"""Coverage boundaries must distinguish noise evidence from speech evidence."""
import array
import io
import unittest
import wave
from quality import coverage_warning


def recording():
    # Deliberately energetic audio: the old loudness-only check flags the beginning.
    samples = array.array('h', [1000, -1000] * (16000 * 6 // 2))
    out = io.BytesIO()
    with wave.open(out, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
        audio.writeframes(samples.tobytes())
    return out.getvalue()


class Coverage(unittest.TestCase):
    def test_noise_before_complete_speech_is_not_missing_speech(self):
        result = {'transcription':[{'text':'the blue notebook is here','offsets':{'from':2500,'to':5900}}]}
        self.assertIsNotNone(coverage_warning(result,recording(),'the blue notebook is here'))
        self.assertIsNone(coverage_warning(result,recording(),'the blue notebook is here',[(2.4,5.9)]))
        self.assertIn('missing beginning',coverage_warning(result,recording(),'the blue notebook is here',[(0,1.5),(2.4,5.9)]))

    def test_speech_after_transcript_still_warns(self):
        result = {'transcription':[{'text':'the blue notebook is here','offsets':{'from':0,'to':2000}}]}
        self.assertIn('missing ending',coverage_warning(result,recording(),'the blue notebook is here',[(0,2),(3,5.9)]))

    def test_invalid_coverage_and_sparse_output_keep_guards(self):
        self.assertIsNotNone(coverage_warning({},recording(),'the blue notebook is here',[]))
        result = {'transcription':[{'text':'time','offsets':{'from':0,'to':6000}}]}
        self.assertIn('Very little text',coverage_warning(result,recording(),'time'))


if __name__ == '__main__':
    unittest.main()

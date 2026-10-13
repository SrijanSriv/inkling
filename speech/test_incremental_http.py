"""Private gateway protocol checks with a fake recognizer; no external service or messages."""
import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer
import server
from incremental import Sessions


class Protocol(unittest.TestCase):
    def setUp(self):
        self.previous = server.INCREMENTAL, server.SECRET
        server.SECRET='fixture'
        self.engine=Sessions(lambda pcm:{'text':'fixture final'},lambda result,pcm:{'text':result['text']},start=False)
        server.INCREMENTAL=self.engine
        self.http=ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=self.http.serve_forever,daemon=True).start()
        self.addCleanup(self.restore)

    def restore(self):
        self.http.shutdown()
        self.http.server_close()
        self.engine.close()
        server.INCREMENTAL,server.SECRET=self.previous

    def request(self,path,method='GET',body=None,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=2)
        try:
            connection.request(method,path,body=body,headers={'Authorization':'Bearer fixture',**(headers or {})})
            result=connection.getresponse()
            import json
            return result.status,json.loads(result.read())
        finally:
            connection.close()

    def test_auth_offsets_finish_and_discarded_results(self):
        self.assertEqual(self.request('/microphone/session','POST',headers={'Authorization':'Bearer wrong'})[0],401)
        status,result=self.request('/microphone/session','POST')
        self.assertEqual(status,200)
        ident=result['id'];base='/microphone/session/'+ident
        self.assertEqual(self.request(base+'/audio','POST',b'\x01\x02'*8000,
            {'Content-Type':'application/octet-stream','X-Inkling-Offset':'2'})[0],409)
        self.assertEqual(self.request(base+'/audio','POST',b'\x01\x02'*8000,
            {'Content-Type':'application/octet-stream','X-Inkling-Offset':'0'})[0],200)
        self.assertEqual(self.request(base+'/finish','POST',headers={'X-Inkling-Size':'16002'})[0],409)
        self.assertEqual(self.request(base+'/finish','POST',headers={'X-Inkling-Size':'16000'})[0],200)
        self.engine.step()
        self.assertEqual(self.request(base)[1]['result']['text'],'fixture final')
        self.assertEqual(self.request(base+'/finish','POST',headers={'X-Inkling-Size':'16000'})[1]['state'],'done')
        self.assertEqual(self.request(base,'DELETE')[1]['state'],'cancelled')
        self.assertIsNone(self.request(base)[1]['result'])

    def test_feature_off_and_invalid_routes(self):
        for path in ['/microphone/session/../../health','/microphone/session/not-an-id/audio']:
            self.assertEqual(self.request(path,'POST')[0],404)
        server.INCREMENTAL=None
        self.assertEqual(self.request('/microphone/session','POST')[0],404)


if __name__ == '__main__':
    unittest.main()

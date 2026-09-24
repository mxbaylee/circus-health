"""Offline PDF wire regression for the exact pinned ChatGPT Responses route.

Run in the patched image with LITELLM_LOCAL_MODEL_COST_MAP=True. This checks
translation against a local fictional upstream, not live provider PDF support.
"""
import asyncio
import base64
import http.server
import importlib.metadata
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'


def fictional_pdf():
    stream = b'BT /F1 12 Tf 24 72 Td (FICTIONAL PDF WIRE CHECK) Tj ET'
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream',
    ]
    document, offsets = b'%PDF-1.4\n', [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(document))
        document += f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(document)
    document += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    document += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return document + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


PDF = fictional_pdf()
PDF_DATA = 'data:application/pdf;base64,' + base64.b64encode(PDF).decode()


class Handler(http.server.BaseHTTPRequestHandler):
    requests = []

    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        type(self).requests.append((self.path, json.loads(self.rfile.read(size))))
        response = {
            'id': 'resp_fictional_pdf', 'object': 'response', 'created_at': 1,
            'model': 'gpt-6-astra', 'status': 'completed',
            'output': [{
                'id': 'msg_fictional_pdf', 'type': 'message', 'status': 'completed',
                'role': 'assistant', 'content': [{
                    'type': 'output_text', 'text': 'Fictional PDF received.', 'annotations': [],
                }],
            }],
            'error': None, 'incomplete_details': None,
        }
        body = ('data: ' + json.dumps({'type': 'response.completed', 'response': response})
                + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


class NativePDFTests(unittest.TestCase):
    def test_selected_chatgpt_responses_route_preserves_native_pdf_bytes_after_tool_result(self):
        if '--offline-worker' not in sys.argv:
            # Keep guards alive until all LiteLLM background threads exit. A
            # method-scoped mock can disappear before deferred cost callbacks.
            with tempfile.TemporaryDirectory(prefix='circus-pdf-offline-home-') as home:
                result = subprocess.run(
                    [sys.executable, __file__, '--offline-worker'],
                    env={'PATH': os.environ.get('PATH', ''), 'HOME': home,
                         'CHATGPT_TOKEN_DIR': home,
                         'LITELLM_LOCAL_MODEL_COST_MAP': 'True'},
                    capture_output=True, text=True, timeout=90,
                )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return
        import litellm
        self.assertEqual(importlib.metadata.version('litellm'), '1.99.1')
        Handler.requests = []
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original_connect = socket.socket.connect

        def local_connect(sock, address):
            if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
                raise AssertionError('Offline PDF regression attempted non-loopback networking')
            return original_connect(sock, address)

        async def call():
            router = litellm.Router(model_list=[{
                'model_name': 'health-primary',
                'litellm_params': {'model': 'chatgpt/gpt-6-astra'},
                'model_info': {'mode': 'responses', 'supports_function_calling': True,
                               'supports_vision': True},
            }], num_retries=0, fallbacks=[])
            return await router.acompletion(
                model='health-primary', stream=False, disable_fallbacks=True,
                messages=[
                    {'role': 'system', 'content': 'Inspect only this fictional scoped page.'},
                    {'role': 'user', 'content': 'Read fictional page 1.'},
                    {'role': 'assistant', 'content': None, 'tool_calls': [{
                        'id': 'fictional_read', 'type': 'function',
                        'function': {'name': 'health_intake_read', 'arguments': '{"page":1}'},
                    }]},
                    {'role': 'tool', 'tool_call_id': 'fictional_read',
                     'content': '{"page":1,"fictional":true}'},
                    {'role': 'user', 'content': [
                        {'type': 'text', 'text': 'Original scoped fictional page.'},
                        {'type': 'file', 'file': {'filename': 'page-1.pdf', 'file_data': PDF_DATA}},
                    ]},
                ],
                tools=[{'type': 'function', 'function': {
                    'name': 'health_intake_read', 'description': 'Read a fictional page.',
                    'parameters': {'type': 'object', 'properties': {'page': {'type': 'integer'}}},
                }}],
            )

        with tempfile.TemporaryDirectory(prefix='circus-pdf-fictional-auth-') as auth:
            environment = {'CHATGPT_TOKEN_DIR': auth,
                           'CHATGPT_API_BASE': f'http://127.0.0.1:{server.server_port}/v1'}
            try:
                with (patch.dict(os.environ, environment),
                      patch.object(socket.socket, 'connect', local_connect),
                      patch('litellm.llms.chatgpt.authenticator.Authenticator._login_device_code',
                            side_effect=AssertionError('Offline test must never request device login')),
                      patch('litellm.llms.chatgpt.authenticator.Authenticator.get_access_token',
                            return_value='fictional-token'),
                      patch('litellm.llms.chatgpt.authenticator.Authenticator.get_account_id',
                            return_value='fictional-account')):
                    result = asyncio.run(call())
            finally:
                server.shutdown()
                server.server_close()
        self.assertEqual(result.choices[0].message.content, 'Fictional PDF received.')
        self.assertEqual(len(Handler.requests), 1)
        path, request = Handler.requests[0]
        self.assertTrue(path.endswith('/responses'), path)
        self.assertEqual(request['model'], 'gpt-6-astra')
        files = [part for item in request['input'] for part in item.get('content', [])
                 if isinstance(part, dict) and part.get('type') == 'input_file']
        self.assertEqual(files, [{'type': 'input_file', 'filename': 'page-1.pdf', 'file_data': PDF_DATA}])
        self.assertEqual(base64.b64decode(files[0]['file_data'].split(',', 1)[1]), PDF)
        self.assertTrue(any(item.get('type') == 'function_call_output' for item in request['input']))
        self.assertEqual(request['tools'][0]['name'], 'health_intake_read')


if __name__ == '__main__':
    if '--offline-worker' in sys.argv:
        # Install the permanent network guard before importing LiteLLM; it also
        # covers callbacks that run after unittest has finished. The parent
        # supplies a fresh HOME and no inherited provider credentials.
        def guard_network(event, args):
            if event == 'socket.connect':
                address = args[1]
                if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
                    raise AssertionError('Offline PDF worker attempted non-loopback networking')
            if event == 'socket.getaddrinfo' and args[0] not in ('127.0.0.1', '::1', None):
                raise AssertionError('Offline PDF worker attempted external name resolution')
        sys.addaudithook(guard_network)
        patch('litellm.llms.chatgpt.authenticator.Authenticator.get_access_token',
              return_value='fictional-token').start()
        patch('litellm.llms.chatgpt.authenticator.Authenticator.get_account_id',
              return_value='fictional-account').start()
        patch('litellm.llms.chatgpt.authenticator.Authenticator._login_device_code',
              side_effect=AssertionError('Offline PDF worker must never request device login')).start()
        outcome = unittest.main(argv=[sys.argv[0]], exit=False)
        sys.exit(0 if outcome.result.wasSuccessful() else 1)
    else:
        unittest.main()

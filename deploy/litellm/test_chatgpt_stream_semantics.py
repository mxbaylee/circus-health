"""Exact offline regression for non-streaming chat over ChatGPT Responses SSE."""
import asyncio
import http.server
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

import litellm


PRIVATE_INPUT = 'FICTIONAL-PRIVATE-INPUT'
EXPECTED_OUTPUT = 'Fictional recovered output.'


def sse(event):
    return ('data: ' + json.dumps(event) + '\n\n').encode()


class Handler(http.server.BaseHTTPRequestHandler):
    request = None
    events = []

    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        type(self).request = json.loads(self.rfile.read(length))
        body = b''.join(sse(event) for event in type(self).events)
        body += b'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


class ChatGPTStreamSemanticsTests(unittest.TestCase):
    @staticmethod
    def response():
        return {
            'id': 'resp_fictional', 'object': 'response', 'created_at': 1,
            'model': 'gpt-6-astra', 'status': 'completed', 'output': [],
            'error': None, 'incomplete_details': None,
        }

    def call(self, events, *, tools=None):
        Handler.events = events
        Handler.request = None
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory(prefix='circus-chatgpt-auth-') as auth:
            environment = {
                'CHATGPT_TOKEN_DIR': auth,
                'CHATGPT_API_BASE': f'http://127.0.0.1:{server.server_port}/v1',
                'LITELLM_LOCAL_MODEL_COST_MAP': 'True',
            }
            try:
                with (patch.dict(os.environ, environment),
                      patch('litellm.llms.chatgpt.authenticator.Authenticator.get_access_token',
                            return_value='fictional-access-token'),
                      patch('litellm.llms.chatgpt.authenticator.Authenticator.get_account_id',
                            return_value='fictional-account')):
                    result = asyncio.run(litellm.acompletion(
                        model='chatgpt/responses/gpt-6-astra',
                        messages=[{'role': 'user', 'content': PRIVATE_INPUT}],
                        stream=False, tools=tools, num_retries=0,
                    ))
            finally:
                server.shutdown()
                server.server_close()
        self.assertTrue(Handler.request['stream'], 'ChatGPT wire request must still ask for SSE')
        self.assertIn(PRIVATE_INPUT, json.dumps(Handler.request))
        return result

    def test_nonstreaming_chat_recovers_output_items_from_provider_sse(self):
        item = {
            'id': 'msg_fictional', 'type': 'message', 'status': 'completed',
            'role': 'assistant',
            'content': [{'type': 'output_text', 'text': EXPECTED_OUTPUT, 'annotations': []}],
        }
        result = self.call([
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': self.response()},
        ])
        self.assertEqual(result.choices[0].message.content, EXPECTED_OUTPUT)

    def test_nonstreaming_chat_recovers_function_call_and_preserves_tools(self):
        item = {
            'id': 'fc_fictional', 'type': 'function_call', 'status': 'completed',
            'call_id': 'call_health_connection', 'name': 'health_connection_test',
            'arguments': '{"probe":"fictional"}',
        }
        tools = [{'type': 'function', 'function': {
            'name': 'health_connection_test', 'description': 'Fictional connectivity probe.',
            'parameters': {'type': 'object', 'properties': {'probe': {'type': 'string'}}},
        }}]
        result = self.call([
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': self.response()},
        ], tools=tools)
        call = result.choices[0].message.tool_calls[0]
        self.assertEqual(call.id, 'call_health_connection')
        self.assertEqual(call.function.name, 'health_connection_test')
        self.assertEqual(json.loads(call.function.arguments), {'probe': 'fictional'})
        self.assertEqual(Handler.request['tools'][0]['name'], 'health_connection_test')

    def test_nonstreaming_chat_keeps_text_and_function_call_in_one_choice(self):
        text_item = {
            'id': 'msg_fictional', 'type': 'message', 'status': 'completed',
            'role': 'assistant',
            'content': [{'type': 'output_text', 'text': EXPECTED_OUTPUT, 'annotations': []}],
        }
        call_item = {
            'id': 'fc_fictional', 'type': 'function_call', 'status': 'completed',
            'call_id': 'call_health_connection', 'name': 'health_connection_test',
            'arguments': '{"probe":"fictional"}',
        }
        tools = [{'type': 'function', 'function': {
            'name': 'health_connection_test', 'description': 'Fictional connectivity probe.',
            'parameters': {'type': 'object', 'properties': {'probe': {'type': 'string'}}},
        }}]
        result = self.call([
            {'type': 'response.output_item.done', 'output_index': 0, 'item': text_item},
            {'type': 'response.output_item.done', 'output_index': 1, 'item': call_item},
            {'type': 'response.completed', 'response': self.response()},
        ], tools=tools)
        self.assertEqual(len(result.choices), 1)
        self.assertEqual(result.choices[0].index, 0)
        self.assertEqual(result.choices[0].finish_reason, 'tool_calls')
        self.assertEqual(result.choices[0].message.content, EXPECTED_OUTPUT)
        self.assertEqual(result.choices[0].message.tool_calls[0].id,
                         'call_health_connection')

if __name__ == '__main__':
    unittest.main()

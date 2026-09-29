"""Offline checks against the callback API in the pinned LiteLLM image."""
import contextlib
import asyncio
import datetime
import http.server
import io
import json
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from litellm.litellm_core_utils.litellm_logging import Logging
import litellm

import response_diagnostics as diagnostics


SECRET = 'FICTIONAL-PROMPT-SECRET-DO-NOT-LOG'


def event(event_type, response=None, **private):
    value = {'type': event_type, **private}
    if response is not None:
        value['response'] = response
    return 'data: ' + json.dumps(value) + '\n\n'


class ResponseDiagnosticsTests(unittest.TestCase):
    def test_pinned_litellm_post_call_invokes_callback_without_content(self):
        raw = ''.join([
            event('response.created', {'status': 'in_progress', 'output': [], 'instructions': SECRET}),
            event('response.output_text.delta', delta=SECRET),
            event('future.private.event', payload=SECRET),
            event('response.incomplete', {
                'status': 'incomplete', 'output': [],
                'incomplete_details': {'reason': 'max_output_tokens'}, 'error': SECRET,
            }),
        ])
        with tempfile.TemporaryDirectory(prefix='circus-diagnostic-') as temporary:
            output = Path(temporary) / 'diagnostic.json'
            logger = Logging(model='fictional', messages=[{'role': 'user', 'content': SECRET}],
                             stream=False, call_type='responses', start_time=datetime.datetime.now(),
                             litellm_call_id='fictional', function_id='fictional',
                             dynamic_input_callbacks=[diagnostics.response_diagnostics])
            stderr = io.StringIO()
            with patch.object(diagnostics, 'DIAGNOSTIC_PATH', output), contextlib.redirect_stderr(stderr):
                logger.post_call(original_response=raw)
            written = output.read_text()
            self.assertNotIn(SECRET, written + stderr.getvalue())
            summary = json.loads(written)
            self.assertEqual(summary['response_status'], 'incomplete')
            self.assertEqual(summary['incomplete_reason'], 'max_output_tokens')
            self.assertEqual(summary['output_item_count'], 0)
            self.assertEqual(summary['event_counts']['response.output_text.delta'], 1)
            self.assertEqual(summary['other_event_count'], 1)

    def test_ignores_nonempty_nonterminal_and_malformed_responses(self):
        fixtures = [
            event('response.created', {'status': 'in_progress', 'output': []}),
            event('response.completed', {'status': 'completed', 'output': [{'type': 'message', 'text': SECRET}]}),
            'data: {"type": "response.completed", "response": ' + SECRET + '\n\n',
        ]
        for raw in fixtures:
            with self.subTest(raw=raw[:30]):
                summary = diagnostics.summarize_response(raw)
                self.assertEqual(summary['diagnostic'], 'responses_api_observation')

    def test_truncated_input_reports_partial_counts(self):
        terminal = event('response.completed', {'status': 'completed', 'output': []})
        with (tempfile.TemporaryDirectory(prefix='circus-capture-') as temporary,
              patch.object(diagnostics, 'MAX_RAW_CHARACTERS', len(terminal)),
              patch.object(diagnostics, 'RESPONSE_BODY_PATH', Path(temporary) / 'body.txt'),
              patch.dict('os.environ', {'CRS_LITELLM_CAPTURE_RESPONSE': 'true'})):
            summary = diagnostics.summarize_response(event('response.created') + terminal)
            summary.update(diagnostics._capture_response(event('response.created') + terminal))
            captured = (Path(temporary) / 'body.txt').read_text()
        self.assertTrue(summary['input_truncated'])
        self.assertTrue(summary['capture_truncated'])
        self.assertEqual(captured, terminal)
        self.assertEqual(summary['event_counts'], {'response.completed': 1})

    def test_arbitrary_status_reason_and_event_type_are_never_emitted(self):
        raw = event([SECRET], payload=SECRET) + event('response.incomplete', {
            'status': SECRET, 'output': [], 'incomplete_details': {'reason': SECRET},
        })
        encoded = json.dumps(diagnostics.summarize_response(raw), sort_keys=True)
        self.assertNotIn(SECRET, encoded)
        self.assertIn('"response_status": "other"', encoded)
        self.assertIn('"incomplete_reason": "other"', encoded)

    def test_actual_async_completion_failure_publishes_safe_observation(self):
        raw = event('response.completed', {
            'id': 'response-fictional', 'object': 'response', 'created_at': 1,
            'model': 'fictional', 'status': 'completed', 'output': [],
            'instructions': SECRET, 'error': None, 'incomplete_details': None,
        })

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('content-length', '0'))
                self.server.request_body = self.rfile.read(length)
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(raw.encode())

            def log_message(self, format, *args):
                return

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original = (litellm.callbacks, litellm.input_callback, litellm.success_callback,
                    litellm.failure_callback, litellm._async_success_callback,
                    litellm._async_failure_callback)
        with tempfile.TemporaryDirectory(prefix='circus-async-diagnostic-') as temporary:
            output = Path(temporary) / 'diagnostic.json'
            body_output = Path(temporary) / 'response-body.txt'
            stderr = io.StringIO()
            try:
                litellm.callbacks = [diagnostics.response_diagnostics]
                litellm.input_callback = []
                litellm.success_callback = []
                litellm.failure_callback = []
                litellm._async_success_callback = []
                litellm._async_failure_callback = []
                with (patch.object(diagnostics, 'DIAGNOSTIC_PATH', output),
                      patch.object(diagnostics, 'RESPONSE_BODY_PATH', body_output),
                      patch.dict('os.environ', {'CRS_LITELLM_CAPTURE_RESPONSE': 'true'}),
                      contextlib.redirect_stderr(stderr)):
                    with self.assertRaises(Exception):
                        asyncio.run(litellm.acompletion(
                            model='openai/responses/fictional',
                            messages=[{'role': 'user', 'content': SECRET}],
                            api_base=f'http://127.0.0.1:{server.server_port}/v1',
                            api_key='fictional-key', num_retries=0,
                        ))
                self.assertIn(SECRET.encode(), server.request_body)
                rendered = output.read_text() + stderr.getvalue()
                self.assertNotIn(SECRET, rendered)
                self.assertIn(SECRET, body_output.read_text())
                self.assertEqual(body_output.stat().st_mode & 0o777, 0o600)
                summary = json.loads(output.read_text())
                self.assertTrue(summary['capture_written'])
                self.assertFalse(summary['capture_truncated'])
                self.assertIn(summary['phase'], ('failure', 'post_api_call'))
                self.assertEqual(summary['raw_shape'], 'sse')
            finally:
                (litellm.callbacks, litellm.input_callback, litellm.success_callback,
                 litellm.failure_callback, litellm._async_success_callback,
                 litellm._async_failure_callback) = original
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()

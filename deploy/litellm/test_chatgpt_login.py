"""Run in the pinned LiteLLM image with --network none; all OAuth is fictional."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from litellm.llms.chatgpt.authenticator import Authenticator

script = Path(os.environ.get('CIRCUS_LOGIN_SCRIPT', Path(__file__).parent / 'login.py'))
spec = importlib.util.spec_from_file_location('circus_login', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LoginTests(unittest.TestCase):
    def test_device_login_reuse_and_refresh_persist_across_new_instances(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CHATGPT_TOKEN_DIR': directory, 'CHATGPT_AUTH_FILE': 'auth.json'}):
            output = io.StringIO()
            tokens = {'access_token': 'fictional-access', 'refresh_token': 'fictional-refresh', 'id_token': 'fictional-id'}
            # Exercise the pinned device-flow orchestration, without contacting a provider.
            with patch.object(Authenticator, '_request_device_code', return_value={'user_code': 'FICTIONAL-CODE'}) as device, patch.object(Authenticator, '_poll_for_authorization_code', return_value={}), patch.object(Authenticator, '_exchange_code_for_tokens', return_value=tokens), patch.object(Authenticator, '_get_expires_at', return_value=int(time.time()) + 3600), contextlib.redirect_stdout(output):
                module.login(Authenticator())
                module.login(Authenticator())
                self.assertEqual(device.call_count, 1, 'A new process-equivalent instance must reuse the stored token')
            path = Path(directory) / 'auth.json'
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            saved = json.loads(path.read_text()); saved['expires_at'] = 0; path.write_text(json.dumps(saved))
            # The pinned refresh method must save the replacement token itself.
            class Reply:
                def raise_for_status(self): pass
                def json(self): return {**tokens, 'access_token': 'fictional-refreshed'}
            class Client:
                def post(self, url, **kwargs):
                    self.input = kwargs
                    return Reply()
            client = Client()
            with patch('litellm.llms.chatgpt.authenticator._get_httpx_client', return_value=client), patch.object(Authenticator, '_get_expires_at', return_value=int(time.time()) + 3600), patch.object(Authenticator, '_request_device_code', side_effect=AssertionError('Should refresh, not ask for login')), contextlib.redirect_stdout(output):
                module.login(Authenticator())
            self.assertEqual(client.input['json']['grant_type'], 'refresh_token')
            self.assertEqual(json.loads(path.read_text())['access_token'], 'fictional-refreshed')
            self.assertIn('FICTIONAL-CODE', output.getvalue())
            for secret in ['fictional-access', 'fictional-refresh', 'fictional-refreshed', 'fictional-id']:
                self.assertNotIn(secret, output.getvalue())

    def test_failed_persistence_never_reports_success(self):
        class Unsaved:
            auth_file = '/nonexistent/fictional-token-store/auth.json'
            def get_access_token(self): return 'fictional-unsaved'
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(OSError):
            module.login(Unsaved())
        self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()

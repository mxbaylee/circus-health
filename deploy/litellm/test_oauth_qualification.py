"""Fictional, network-disabled checks against the pinned LiteLLM authenticator."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from litellm.llms.chatgpt.authenticator import Authenticator


script = Path(__file__).with_name('qualify_chatgpt_oauth.py')
spec = importlib.util.spec_from_file_location('circus_oauth_qualification', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OAuthQualificationTests(unittest.TestCase):
    def fixture(self, directory, expires_at):
        path = Path(directory) / 'auth.json'
        path.write_text(json.dumps({
            'access_token': 'fictional-old-access',
            'refresh_token': 'fictional-refresh',
            'id_token': 'fictional-old-id',
            'expires_at': expires_at,
        }))
        path.chmod(0o600)
        return path

    def test_natural_expiry_refresh_persists_and_new_instance_reuses(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CHATGPT_TOKEN_DIR': directory, 'CHATGPT_AUTH_FILE': 'auth.json',
        }):
            path = self.fixture(directory, 0)
            class Reply:
                def raise_for_status(self): pass
                def json(self):
                    return {'access_token': 'fictional-new-access',
                            'refresh_token': 'fictional-new-refresh', 'id_token': 'fictional-new-id'}
            class Client:
                calls = 0
                def post(self, _url, **kwargs):
                    self.calls += 1
                    assert kwargs['json']['grant_type'] == 'refresh_token'
                    return Reply()
            client = Client()
            with patch('litellm.llms.chatgpt.authenticator._get_httpx_client', return_value=client), \
                 patch.object(Authenticator, '_get_expires_at', return_value=int(time.time()) + 3600):
                self.assertEqual(module.run_phase('probe')['status'], 'ready_expired')
                refreshed = module.run_phase('refresh')
                self.assertEqual(refreshed, {'status': 'refreshed', 'refreshObserved': True,
                                             'persistenceObserved': True})
                self.assertEqual(client.calls, 1)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(path.read_text())['access_token'], 'fictional-new-access')
                # A new Authenticator instance models the second clean container.
                reused = module.run_phase('reuse', module.GuardedAuthenticator())
                self.assertEqual(reused, {'status': 'reused', 'refreshObserved': False,
                                          'persistenceObserved': True})
                self.assertEqual(client.calls, 1)

    def test_unexpired_probe_neither_refreshes_nor_rewrites(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CHATGPT_TOKEN_DIR': directory, 'CHATGPT_AUTH_FILE': 'auth.json',
        }):
            path = self.fixture(directory, int(time.time()) + 3600)
            original = path.read_bytes()
            with patch.object(module.GuardedAuthenticator, '_refresh_tokens', side_effect=AssertionError('refresh forbidden')):
                self.assertEqual(module.run_phase('probe')['status'], 'pending_natural_expiry')
                self.assertEqual(module.run_phase('refresh')['status'], 'pending_natural_expiry')
            self.assertEqual(path.read_bytes(), original)

    def test_refresh_failure_cannot_fall_back_to_device_login(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CHATGPT_TOKEN_DIR': directory, 'CHATGPT_AUTH_FILE': 'auth.json',
        }):
            self.fixture(directory, 0)
            with patch('litellm.llms.chatgpt.authenticator._get_httpx_client', side_effect=OSError('fictional provider failure')):
                with self.assertRaises(RuntimeError):
                    module.run_phase('refresh')

    def test_bad_permissions_and_route_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'CHATGPT_TOKEN_DIR': directory, 'CHATGPT_AUTH_FILE': 'auth.json',
            'CRS_MODEL': 'health-primary',
        }):
            path = self.fixture(directory, 0)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                module.run_phase('probe')
            with patch.object(Path, 'read_text', return_value='model_list:\n- model_name: health-primary\n  litellm_params:\n    model: openai/fictional\n'):
                with self.assertRaises(ValueError):
                    module.selected_route()


if __name__ == '__main__':
    unittest.main()

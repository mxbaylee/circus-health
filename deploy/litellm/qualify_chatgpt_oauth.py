"""Qualify natural ChatGPT OAuth refresh in an isolated pinned LiteLLM container.

No token or provider exception is printed. The host runner invokes each phase in a
fresh disposable container while binding the installation's existing auth directory.
"""
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import stat
import sys
import time

import yaml
from litellm.llms.chatgpt.authenticator import Authenticator, TOKEN_EXPIRY_SKEW_SECONDS


class GuardedAuthenticator(Authenticator):
    def __init__(self):
        super().__init__()
        self.refresh_calls = 0

    def _refresh_tokens(self, refresh_token):
        self.refresh_calls += 1
        return super()._refresh_tokens(refresh_token)

    def _login_device_code(self):
        raise RuntimeError('Interactive sign-in is forbidden during qualification.')

    def _wait_for_access_token(self, *_args, **_kwargs):
        raise RuntimeError('Interactive sign-in is forbidden during qualification.')


def selected_route():
    config = yaml.safe_load(Path('/app/config.yaml').read_text())
    aliases = [item for item in config.get('model_list', [])
               if isinstance(item, dict) and item.get('model_name') == os.environ.get('CRS_MODEL')]
    if len(aliases) != 1:
        raise ValueError('Selected model alias is not unique.')
    route = aliases[0].get('litellm_params', {}).get('model')
    if isinstance(route, str) and route.startswith('os.environ/'):
        route = os.environ.get(route[11:])
    if not isinstance(route, str) or not route.startswith('chatgpt/') or '*' in route:
        raise ValueError('Selected model is not an exact ChatGPT OAuth route.')
    return route


def auth_record(auth):
    path = Path(auth.auth_file)
    if path.is_symlink() or not path.is_file():
        raise ValueError('A regular persisted ChatGPT token file is required.')
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError('The persisted ChatGPT token file must have mode 0600.')
    record = json.loads(path.read_text())
    if not isinstance(record, dict) or not record.get('access_token') or not record.get('refresh_token'):
        raise ValueError('The persisted ChatGPT token file is incomplete.')
    expires_at = record.get('expires_at')
    if expires_at is None:
        expires_at = auth._get_expires_at(record['access_token'])
    if expires_at is None:
        raise ValueError('Token expiry cannot be determined without altering it.')
    return path, record, float(expires_at)


def run_phase(phase, auth=None):
    auth = auth or GuardedAuthenticator()
    path, before, expires_at = auth_record(auth)
    expired = time.time() >= expires_at - TOKEN_EXPIRY_SKEW_SECONDS
    if phase == 'probe':
        return {'status': 'ready_expired' if expired else 'pending_natural_expiry',
                'refreshObserved': False, 'persistenceObserved': False}
    if phase == 'refresh':
        if not expired:
            return {'status': 'pending_natural_expiry', 'refreshObserved': False,
                    'persistenceObserved': False}
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            token = auth.get_access_token()
        _, after, new_expiry = auth_record(auth)
        if auth.refresh_calls != 1 or not token or token == before['access_token'] or after.get('access_token') != token:
            raise ValueError('A persisted replacement access token was not observed.')
        if new_expiry <= time.time() + TOKEN_EXPIRY_SKEW_SECONDS:
            raise ValueError('The refreshed token is not valid beyond the expiry guard.')
        return {'status': 'refreshed', 'refreshObserved': True, 'persistenceObserved': True}
    if phase == 'reuse':
        if expired:
            raise ValueError('The saved token is expired before fresh-container reuse.')
        contents = path.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            token = auth.get_access_token()
        if auth.refresh_calls or token != before['access_token'] or path.read_bytes() != contents:
            raise ValueError('Fresh-container reuse changed or refreshed the saved token.')
        return {'status': 'reused', 'refreshObserved': False, 'persistenceObserved': True}
    raise ValueError('Unknown qualification phase.')


if __name__ == '__main__':
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    try:
        selected_route()
        print(json.dumps(run_phase(sys.argv[1])))
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        # Authenticator and provider exceptions can contain credentials or bodies.
        print(json.dumps({'status': 'failed', 'refreshObserved': False,
                          'persistenceObserved': False}))
        sys.exit(1)

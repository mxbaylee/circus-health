"""Interactive ChatGPT login using only the pinned proxy's own token store.

Run through `npm run login:chatgpt`, in the proxy image. Never print returned tokens
or provider exception bodies; the device code is shown only in the user terminal.
"""
import json
import logging
import os
from pathlib import Path
import sys


def login(authenticator=None):
    os.umask(0o077)
    logging.getLogger('LiteLLM').setLevel(logging.CRITICAL)
    if authenticator is None:
        from litellm.llms.chatgpt.authenticator import Authenticator
        authenticator = Authenticator()
    path = Path(authenticator.auth_file)
    if path.is_symlink():
        raise ValueError('Token file cannot be a symlink.')
    if path.exists():
        path.chmod(0o600)
    token = authenticator.get_access_token()
    saved = json.loads(path.read_text())
    if not token or saved.get('access_token') != token or not saved.get('refresh_token'):
        raise ValueError('Authentication was not saved for reuse.')
    path.chmod(0o600)
    print('ChatGPT authentication saved. Start Circus Health with this same STATE_DIR.')


if __name__ == '__main__':
    try:
        login()
    except KeyboardInterrupt:
        print('ChatGPT login cancelled. No model request was sent.', file=sys.stderr)
        sys.exit(130)
    except Exception:
        print('ChatGPT login did not complete or its token file could not be saved. Check device-login permission, network access and STATE_DIR permissions, then retry. Do not share codes or token files.', file=sys.stderr)
        sys.exit(1)

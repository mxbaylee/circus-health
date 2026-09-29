"""Validate an operator configuration and apply the application's proxy boundaries."""
import json
import importlib.util
import os
import sys
from pathlib import Path
import yaml


def bundled_model_cost():
    # Finding a top-level package spec does not execute its __init__. Never use
    # importlib.resources.files('litellm'): it imports the package to find data.
    try:
        spec = importlib.util.find_spec('litellm')
        if spec is None or not spec.origin:
            return {}
        path = Path(spec.origin).parent / 'model_prices_and_context_window_backup.json'
        # The pinned 1.99.1 map is about 1.8 MiB. Bound even a replaced/corrupt
        # metadata file; it is a local hint and never authorizes PDF delivery.
        with path.open('rb') as source:
            raw = source.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            return {}
        cost = json.loads(raw)
        if not isinstance(cost, dict) or any(not isinstance(entry, dict) for entry in cost.values()):
            return {}
        # The pinned alias loader cannot initialize from unhashable aliases.
        # Reject malformed lists as a whole rather than recovering support from
        # some other entry. Non-list alias fields remain ignored, as upstream.
        for entry in cost.values():
            aliases = entry.get('aliases')
            if isinstance(aliases, list) and any(not isinstance(alias, str) for alias in aliases):
                return {}
        # This is loader control metadata, never a canonical model entry.
        # Remove it before alias expansion, just as the pinned finalizer does.
        cost.pop('fallback_generalizations', None)
        return cost
    except Exception:
        return {}


def model_cost_entry(cost, name):
    # Match the pinned map's explicit alias expansion: canonical keys win,
    # otherwise the first declared alias wins. Never infer a model family.
    if name in cost:
        return cost[name]
    for entry in cost.values():
        if not isinstance(entry, dict):
            continue
        aliases = entry.get('aliases')
        if isinstance(aliases, list) and name in aliases:
            return entry
    return None


def pdf_capability(selected, upstream):
    info = selected.get('model_info', {})
    if 'supports_pdf_input' in info:
        declared = info['supports_pdf_input']
        if not isinstance(declared, bool):
            raise ValueError('model_info.supports_pdf_input must be true or false.')
        return declared
    # Metadata-only preflight must never initialize LiteLLM, authenticate, fetch
    # remote cost data or borrow another provider's similarly named model.
    cost = bundled_model_cost()
    entry = model_cost_entry(cost, upstream)
    if entry is None:
        provider, _, model = upstream.partition('/')
        entry = model_cost_entry(cost, model)
        if not isinstance(entry, dict) or entry.get('litellm_provider') != provider:
            return False
    return isinstance(entry, dict) and entry.get('supports_pdf_input') is True


def configured():
    config = yaml.safe_load(Path('/app/config.yaml').read_text())
    if not isinstance(config, dict) or not isinstance(config.get('model_list'), list):
        raise ValueError('LiteLLM config must contain model_list.')
    model = os.environ.get('CRS_MODEL', '')
    matches = [entry for entry in config['model_list'] if isinstance(entry, dict) and entry.get('model_name') == model]
    if len(matches) != 1:
        raise ValueError('CRS_MODEL must select exactly one model_list entry; wildcard aliases and duplicate deployments are unsupported.')
    # Fail closed rather than retaining callbacks/caches or fallback routes that
    # could duplicate a private archive or change the user's provider selection.
    forbidden = {'fallbacks', 'default_fallbacks', 'context_window_fallbacks', 'content_policy_fallbacks',
                 'callbacks', 'success_callback', 'failure_callback', 'input_callback', 'service_callback',
                 'cache', 'cache_params', 'database_url', 'store_model_in_db', 'turn_on_message_logging',
                 'set_verbose', 'json_logs', 'default_team_settings', 'pass_through_endpoints'}
    def check(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in forbidden and child:
                    raise ValueError('Circus Health config cannot enable fallback routes, payload logging, caches, databases or callbacks.')
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)
    check(config)
    selected = matches[0]
    params = selected.get('litellm_params', {})
    upstream = params.get('model')
    if isinstance(upstream, str) and upstream.startswith('os.environ/'):
        upstream = os.environ.get(upstream[11:])
    if not isinstance(upstream, str) or '/' not in upstream or '*' in upstream:
        raise ValueError('Selected litellm_params.model must name a provider and exact model, such as openai/model-name.')
    config['model_list'] = [selected]
    config.setdefault('general_settings', {})['master_key'] = 'os.environ/LITELLM_MASTER_KEY'
    litellm_settings = config.setdefault('litellm_settings', {})
    litellm_settings.update({'set_verbose': False, 'num_retries': 0, 'cache': False})
    diagnostics = os.environ.get('CRS_LITELLM_RESPONSE_DIAGNOSTICS', 'false').lower()
    if diagnostics not in ('true', 'false'):
        raise ValueError('CRS_LITELLM_RESPONSE_DIAGNOSTICS must be true or false.')
    capture = os.environ.get('CRS_LITELLM_CAPTURE_RESPONSE', 'false').lower()
    if capture not in ('true', 'false'):
        raise ValueError('CRS_LITELLM_CAPTURE_RESPONSE must be true or false.')
    if diagnostics == 'true' or capture == 'true':
        # This project-owned callback is fixed here after operator callbacks have
        # been rejected above. Raw response capture requires a separate explicit
        # flag and is bounded to the proxy's temporary filesystem.
        litellm_settings['callbacks'] = ['response_diagnostics.response_diagnostics']
    config.setdefault('router_settings', {}).update({'num_retries': 0, 'fallbacks': [], 'default_fallbacks': []})
    images = selected.get('model_info', {}).get('supports_vision', False)
    if not isinstance(images, bool):
        raise ValueError('model_info.supports_vision must be true or false.')
    prompt_cache = selected.get('model_info', {}).get('supports_prompt_caching', False)
    if not isinstance(prompt_cache, bool):
        raise ValueError('model_info.supports_prompt_caching must be true or false.')
    return config, {'response_model': upstream.split('/', 1)[1], 'images': images,
                    'promptCache': prompt_cache, 'pdf': pdf_capability(selected, upstream)}


try:
    config, settings = configured()
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        print(json.dumps(settings))
    else:
        Path('/tmp/circus-litellm.yaml').write_text(yaml.safe_dump(config))
except Exception as error:
    # YAML parser exceptions can echo a line containing a key. Never print them.
    message = str(error) if type(error) is ValueError else 'Could not read LiteLLM configuration; check its YAML structure.'
    if len(sys.argv) > 1 and sys.argv[1] == 'check':
        print(json.dumps({'error': message}))
    else:
        print(message, file=sys.stderr)
        sys.exit(1)

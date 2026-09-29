"""Offline tests for the app's LiteLLM configuration boundary.

Run in the pinned LiteLLM image (which supplies PyYAML), with this file and
configure.py mounted read-only. Set CRS_CONFIGURE_SCRIPT to that script path.
All configuration and generated files are fictional temporary fixtures.
"""
import contextlib
import builtins
import importlib.util
import copy
import io
import json
import os
from pathlib import Path
import runpy
import sys
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

import yaml

SCRIPT = Path(os.environ.get('CRS_CONFIGURE_SCRIPT', Path(__file__).parent / 'configure.py'))


def sample():
    return {'model_list': [
        {'model_name': 'health-primary', 'litellm_params': {'model': 'openai/fictional-model', 'api_key': 'os.environ/FICTIONAL_KEY'}},
        {'model_name': 'unused', 'litellm_params': {'model': 'anthropic/fictional-other'}},
    ]}


class ConfigureTests(unittest.TestCase):
    def invoke(self, config=None, *, raw=None, check=True, alias='health-primary', extra_env=None, model_cost=None, metadata_raw=None, metadata_missing=False, spec_missing=False):
        original = raw if raw is not None else yaml.safe_dump(config if config is not None else sample())
        with tempfile.TemporaryDirectory(prefix='circus-config-test-') as temporary:
            source = Path(temporary) / 'operator.yaml'
            generated = Path(temporary) / 'generated.yaml'
            source.write_text(original)
            source.chmod(0o400)
            real_read, real_write = Path.read_text, Path.write_text
            reads, writes = [], []

            def read(path, *args, **kwargs):
                if str(path) == '/app/config.yaml':
                    reads.append(str(path))
                    return real_read(source, *args, **kwargs)
                return real_read(path, *args, **kwargs)

            def write(path, *args, **kwargs):
                writes.append(str(path))
                self.assertEqual(str(path), '/tmp/circus-litellm.yaml', 'Only the generated temporary configuration may be written')
                return real_write(generated, *args, **kwargs)

            metadata = Path(temporary) / 'model_prices_and_context_window_backup.json'
            if not metadata_missing:
                metadata.write_text(metadata_raw if metadata_raw is not None else json.dumps(model_cost if model_cost is not None else {}))
            detector = Mock(side_effect=AssertionError('Capability preflight must not resolve/authenticate providers'))
            real_import = builtins.__import__
            import_attempts, network_attempts, file_opens = [], [], []
            real_open = Path.open
            def local_open(path, *args, **kwargs):
                file_opens.append(str(path))
                if path not in (source, generated, metadata):
                    raise AssertionError('Unexpected file opened by metadata preflight')
                return real_open(path, *args, **kwargs)
            def no_network(*args, **kwargs):
                network_attempts.append('network')
                raise AssertionError('Metadata preflight attempted network access')
            def guarded_import(name, *args, **kwargs):
                if name == 'litellm' or name.startswith('litellm.'):
                    import_attempts.append(name)
                    raise AssertionError('Metadata preflight imported LiteLLM')
                return real_import(name, *args, **kwargs)
            stdout, stderr, status = io.StringIO(), io.StringIO(), 0
            env = {'CRS_MODEL': alias, 'FICTIONAL_KEY': 'fictional-private-value', **(extra_env or {})}
            with patch.object(importlib.util, 'find_spec', return_value=None if spec_missing else SimpleNamespace(origin=str(Path(temporary) / '__init__.py'))) as package_spec, patch.object(builtins, '__import__', guarded_import), patch.object(socket, 'socket', no_network), patch.object(socket, 'create_connection', no_network), patch.object(Path, 'open', local_open), patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', [str(SCRIPT)] + (['check'] if check else [])), patch.object(Path, 'read_text', read), patch.object(Path, 'write_text', write), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                try:
                    runpy.run_path(str(SCRIPT), run_name='__main__')
                except SystemExit as error:
                    status = error.code
            self.assertEqual(import_attempts, [], 'LiteLLM initialization must never be attempted')
            self.assertEqual(network_attempts, [], 'Network must never be attempted')
            self.assertTrue(all(path in (str(source), str(generated), str(metadata)) for path in file_opens), 'No auth, model state or unrelated files may be opened')
            self.assertEqual(source.read_text(), original, 'The operator configuration must remain byte-identical')
            self.assertEqual(reads, ['/app/config.yaml'])
            self.assertNotIn('/app/config.yaml', writes)
            if check:
                self.assertEqual(writes, [], 'Preflight must never generate or mutate configuration')
            return {'stdout': stdout.getvalue(), 'stderr': stderr.getvalue(), 'status': status,
                    'settings': json.loads(stdout.getvalue()) if check else None, 'pdf_detector': detector, 'package_spec_calls': package_spec.call_count,
                    'generated': yaml.safe_load(generated.read_text()) if generated.exists() else None}

    def test_requires_one_exact_alias(self):
        duplicate = sample(); duplicate['model_list'].append(copy.deepcopy(duplicate['model_list'][0]))
        wildcard = sample(); wildcard['model_list'][0]['model_name'] = '*'
        for config in [duplicate, wildcard, {'model_list': []}]:
            with self.subTest(config=config):
                self.assertIn('exactly one', self.invoke(config)['settings']['error'])
        self.assertIn('exactly one', self.invoke(alias='missing')['settings']['error'])

    def test_prunes_unselected_entries_and_enforces_master_key_and_no_retries(self):
        config = sample()
        config.update({'general_settings': {'master_key': 'fictional-operator-key'},
                       'litellm_settings': {'num_retries': 7}, 'router_settings': {'num_retries': 9}})
        result = self.invoke(config, check=False)
        self.assertEqual(result['status'], 0)
        generated = result['generated']
        self.assertEqual(generated['model_list'], [config['model_list'][0]])
        self.assertEqual(generated['general_settings']['master_key'], 'os.environ/LITELLM_MASTER_KEY')
        self.assertEqual(generated['router_settings']['num_retries'], 0)
        self.assertEqual(generated['router_settings']['fallbacks'], [])
        self.assertEqual(generated['router_settings']['default_fallbacks'], [])
        self.assertEqual(generated['litellm_settings'], {'num_retries': 0, 'set_verbose': False, 'cache': False})
        self.assertNotIn('fictional-operator-key', yaml.safe_dump(generated))
        self.assertNotIn('fictional-private-value', result['stdout'] + result['stderr'] + yaml.safe_dump(generated))

    def test_derives_response_identity_and_explicit_vision(self):
        self.assertEqual(self.invoke()['settings'], {'response_model': 'fictional-model', 'images': False, 'promptCache': False, 'pdf': False})
        config = sample(); config['model_list'][0]['litellm_params']['model'] = 'openai/vendor/fictional-model'
        config['model_list'][0]['model_info'] = {'supports_vision': True}
        self.assertEqual(self.invoke(config)['settings'], {'response_model': 'vendor/fictional-model', 'images': True, 'promptCache': False, 'pdf': False})
        config['model_list'][0]['model_info']['supports_vision'] = 'true'
        self.assertIn('must be true or false', self.invoke(config)['settings']['error'])

    def test_derives_explicit_prompt_cache_hint(self):
        config = sample()
        config['model_list'][0]['model_info'] = {'supports_prompt_caching': True}
        self.assertEqual(self.invoke(config)['settings'], {'response_model': 'fictional-model', 'images': False, 'promptCache': True, 'pdf': False})
        config['model_list'][0]['model_info']['supports_prompt_caching'] = 'true'
        self.assertIn('must be true or false', self.invoke(config)['settings']['error'])

    def test_pdf_capability_uses_explicit_boolean_before_selected_route_detection(self):
        config = sample()
        for declared in [True, False]:
            config['model_list'][0]['model_info'] = {'supports_pdf_input': declared}
            result = self.invoke(config, model_cost={'openai/fictional-model': {'supports_pdf_input': not declared}})
            self.assertEqual(result['settings']['pdf'], declared)
            result['pdf_detector'].assert_not_called()
            self.assertEqual(result['package_spec_calls'], 0)
        for invalid in ['true', None, 1]:
            config['model_list'][0]['model_info'] = {'supports_pdf_input': invalid}
            self.assertIn('supports_pdf_input must be true or false', self.invoke(config)['settings']['error'])

    def test_packaged_chatgpt_template_declares_pdf_without_provider_discovery(self):
        config = yaml.safe_load((SCRIPT.parent / 'config.chatgpt.example.yaml').read_text())
        selected = config['model_list'][0]
        result = self.invoke(config, alias=selected['model_name'])
        self.assertEqual(result['settings']['response_model'], 'gpt-6-astra')
        self.assertTrue(result['settings']['pdf'])
        result['pdf_detector'].assert_not_called()

    def test_pdf_capability_detects_only_the_selected_upstream_and_fails_closed(self):
        for supported in [True, False, None, 'true']:
            result = self.invoke(model_cost={'openai/fictional-model': {'supports_pdf_input': supported}})
            self.assertIs(result['settings']['pdf'], supported is True)
            result['pdf_detector'].assert_not_called()
        for provider in ['openai', 'another-provider']:
            result = self.invoke(model_cost={'fictional-model': {'litellm_provider': provider, 'supports_pdf_input': True}})
            self.assertEqual(result['settings']['pdf'], provider == 'openai')
        self.assertFalse(self.invoke(model_cost={'anthropic/fictional-other': {'supports_pdf_input': True}})['settings']['pdf'])
        self.assertFalse(self.invoke(model_cost={
            'openai/fictional-model': {'supports_pdf_input': False},
            'fictional-model': {'litellm_provider': 'openai', 'supports_pdf_input': True},
        })['settings']['pdf'])
        config = sample(); config['model_list'][0]['litellm_params']['model'] = 'os.environ/FICTIONAL_MODEL'
        result = self.invoke(config, extra_env={'FICTIONAL_MODEL': 'anthropic/fictional-version'},
                             model_cost={'anthropic/fictional-version': {'supports_pdf_input': True}})
        self.assertTrue(result['settings']['pdf'])

    def test_bundled_alias_lookup_keeps_canonical_precedence_and_provider_boundary(self):
        aliases = {'canonical': {'aliases': ['fictional-model'], 'litellm_provider': 'openai', 'supports_pdf_input': True}}
        self.assertTrue(self.invoke(model_cost=aliases)['settings']['pdf'])
        aliases['fictional-model'] = {'litellm_provider': 'openai', 'supports_pdf_input': False}
        self.assertFalse(self.invoke(model_cost=aliases)['settings']['pdf'])
        aliases = {'canonical': {'aliases': ['fictional-model'], 'litellm_provider': 'another-provider', 'supports_pdf_input': True}}
        self.assertFalse(self.invoke(model_cost=aliases)['settings']['pdf'])
        aliases = {'first': {'aliases': ['openai/fictional-model'], 'supports_pdf_input': False},
                   'second': {'aliases': ['openai/fictional-model'], 'supports_pdf_input': True}}
        self.assertFalse(self.invoke(model_cost=aliases)['settings']['pdf'])
        aliases = {'fallback_generalizations': {'aliases': ['openai/fictional-model'], 'supports_pdf_input': True}}
        self.assertFalse(self.invoke(model_cost=aliases)['settings']['pdf'])
        self.assertTrue(self.invoke(model_cost={'unused': {'aliases': 'not-a-list'}, 'openai/fictional-model': {'supports_pdf_input': True}})['settings']['pdf'])
        config = sample(); config['model_list'][0]['litellm_params']['model'] = 'openai/fallback_generalizations'
        control = {'fallback_generalizations': {'litellm_provider': 'openai', 'supports_pdf_input': True}}
        self.assertFalse(self.invoke(config, model_cost=control)['settings']['pdf'])
        control['canonical'] = {'aliases': ['fallback_generalizations'], 'litellm_provider': 'openai', 'supports_pdf_input': True}
        self.assertTrue(self.invoke(config, model_cost=control)['settings']['pdf'])

    def test_missing_or_corrupt_bundled_data_fails_closed_without_importing_litellm(self):
        for value in [None, [], 'fictional-private-value', {'openai/fictional-model': 'true'}]:
            self.assertFalse(self.invoke(model_cost=value)['settings']['pdf'])
        for options in [{'metadata_missing': True}, {'spec_missing': True},
                        {'metadata_raw': '{fictional-private-value'},
                        {'metadata_raw': ' ' * (8 * 1024 * 1024 + 1)}]:
            result = self.invoke(**options)
            self.assertFalse(result['settings']['pdf'])
            self.assertNotIn('fictional-private-value', result['stdout'] + result['stderr'])
        known = {'litellm_provider': 'openai', 'supports_pdf_input': True}
        for costs in [
            {'openai/fictional-model': None, 'fictional-model': known},
            {'unrelated': None, 'fictional-model': known},
            {'broken': {'aliases': [{}, 'openai/fictional-model'], 'supports_pdf_input': True}},
            {'broken': {'aliases': [[], 'openai/fictional-model'], 'supports_pdf_input': True}},
        ]:
            self.assertFalse(self.invoke(model_cost=costs)['settings']['pdf'])
        self.assertEqual(self.invoke()['package_spec_calls'], 1)

    def test_resolves_environment_model_without_materializing_provider_secrets(self):
        config = sample(); config['model_list'][0]['litellm_params']['model'] = 'os.environ/FICTIONAL_MODEL'
        self.assertEqual(self.invoke(config, extra_env={'FICTIONAL_MODEL': 'anthropic/fictional-version'})['settings']['response_model'], 'fictional-version')
        self.assertIn('provider and exact model', self.invoke(config)['settings']['error'])
        generated = self.invoke(config, check=False, extra_env={'FICTIONAL_MODEL': 'anthropic/fictional-version'})['generated']
        self.assertEqual(generated['model_list'][0]['litellm_params']['model'], 'os.environ/FICTIONAL_MODEL')

    def test_rejects_nonexact_upstream_models(self):
        for value in ['fictional', 'openai/*', None, 42]:
            config = sample(); config['model_list'][0]['litellm_params']['model'] = value
            with self.subTest(value=value):
                self.assertIn('provider and exact model', self.invoke(config)['settings']['error'])

    def test_recursively_rejects_fallbacks_callbacks_caches_and_payload_logging(self):
        for key, value in [('fallbacks', [{'health-primary': ['unused']}]), ('default_fallbacks', ['unused']),
                           ('context_window_fallbacks', ['unused']), ('content_policy_fallbacks', ['unused']),
                           ('callbacks', ['fictional']), ('success_callback', ['fictional']),
                           ('failure_callback', ['fictional']), ('cache', True), ('cache_params', {'type': 'memory'}),
                           ('database_url', 'postgresql://fictional-private-value'), ('turn_on_message_logging', True),
                           ('set_verbose', True)]:
            config = sample(); config['model_list'][1]['nested'] = [{'more': {key: value}}]
            with self.subTest(key=key):
                result = self.invoke(config)
                self.assertIn('cannot enable', result['settings']['error'])
                self.assertNotIn('fictional-private-value', result['stdout'] + result['stderr'])

    def test_disabled_fallbacks_and_callbacks_are_allowed(self):
        config = sample(); config['litellm_settings'] = {'callbacks': [], 'cache': False}
        config['router_settings'] = {'fallbacks': [], 'default_fallbacks': []}
        self.assertNotIn('error', self.invoke(config)['settings'])

    def test_only_fixed_project_diagnostics_callback_can_be_enabled(self):
        result = self.invoke(check=False, extra_env={'CRS_LITELLM_RESPONSE_DIAGNOSTICS': 'true'})
        self.assertEqual(result['generated']['litellm_settings']['callbacks'],
                         ['response_diagnostics.response_diagnostics'])
        invalid = self.invoke(extra_env={'CRS_LITELLM_RESPONSE_DIAGNOSTICS': 'verbose'})
        self.assertIn('must be true or false', invalid['settings']['error'])
        captured = self.invoke(check=False, extra_env={'CRS_LITELLM_CAPTURE_RESPONSE': 'true'})
        self.assertEqual(captured['generated']['litellm_settings']['callbacks'],
                         ['response_diagnostics.response_diagnostics'])

    def test_malformed_yaml_errors_never_echo_secret_lines(self):
        raw = 'model_list: [fictional-private-value\n'
        checked = self.invoke(raw=raw)
        self.assertIn('YAML structure', checked['settings']['error'])
        started = self.invoke(raw=raw, check=False)
        self.assertEqual(started['status'], 1); self.assertIsNone(started['generated'])
        for result in [checked, started]:
            self.assertNotIn('fictional-private-value', result['stdout'] + result['stderr'])
            self.assertNotIn('Traceback', result['stderr'])

    def test_invalid_yaml_structure_is_reported_without_partial_output(self):
        for config in [[], {'model_list': 'wrong'}, {'model_list': [None]}]:
            with self.subTest(config=config):
                self.assertIn('error', self.invoke(config)['settings'])
                result = self.invoke(config, check=False)
                self.assertEqual(result['status'], 1); self.assertIsNone(result['generated'])


if __name__ == '__main__':
    unittest.main()

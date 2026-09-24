"""Opt-in metadata-only diagnostics for Responses API conversion failures."""
import json
import os
import sys
from collections import Counter
from pathlib import Path

from litellm.integrations.custom_logger import CustomLogger


DIAGNOSTIC_PATH = Path('/tmp/circus-litellm-response-diagnostic.json')
RESPONSE_BODY_PATH = Path('/tmp/circus-litellm-response-body.txt')
MAX_RAW_CHARACTERS = 8 * 1024 * 1024
EVENT_TYPES = frozenset({
    'error',
    'response.cancelled',
    'response.completed',
    'response.content_part.added',
    'response.content_part.done',
    'response.created',
    'response.failed',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.in_progress',
    'response.incomplete',
    'response.output_item.added',
    'response.output_item.done',
    'response.output_text.annotation.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.queued',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.refusal.delta',
    'response.refusal.done',
})
RESPONSE_STATUSES = frozenset({'cancelled', 'completed', 'failed', 'in_progress', 'incomplete', 'queued'})
INCOMPLETE_REASONS = frozenset({'content_filter', 'max_output_tokens', 'max_tokens', 'steered'})
TERMINAL_EVENTS = frozenset({'response.cancelled', 'response.completed', 'response.failed', 'response.incomplete'})


def _allowed(value, choices):
    if value is None:
        return None
    return value if isinstance(value, str) and value in choices else 'other'


def _raw_shape(raw):
    if raw is None:
        return 'missing'
    if isinstance(raw, dict):
        return 'mapping'
    if isinstance(raw, list):
        return 'sequence'
    if not isinstance(raw, str):
        return 'other'
    if not raw:
        return 'empty_text'
    if any(line.startswith(('data:', 'event:')) for line in raw.splitlines()):
        return 'sse'
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return 'text'
    if isinstance(parsed, dict):
        return 'json_mapping'
    if isinstance(parsed, list):
        return 'json_sequence'
    return 'json_scalar'


def summarize_response(raw, phase='post_api_call'):
    """Return a fixed-shape summary without copying response content."""
    input_truncated = isinstance(raw, str) and len(raw) > MAX_RAW_CHARACTERS
    if isinstance(raw, str):
        raw = raw[-MAX_RAW_CHARACTERS:]
    shape = _raw_shape(raw)
    counts = Counter()
    other_events = 0
    parse_error_count = 0
    terminal = None

    if shape == 'sse':
        for line in raw.splitlines():
            if not line.startswith('data:'):
                continue
            payload = line[5:].strip()
            if not payload or payload == '[DONE]':
                continue
            try:
                event = json.loads(payload)
            except (json.JSONDecodeError, TypeError, ValueError):
                parse_error_count += 1
                continue
            if not isinstance(event, dict):
                other_events += 1
                continue
            event_type = event.get('type')
            if isinstance(event_type, str) and event_type in EVENT_TYPES:
                counts[event_type] += 1
            else:
                other_events += 1
            if (isinstance(event_type, str) and event_type in TERMINAL_EVENTS
                    and isinstance(event.get('response'), dict)):
                terminal = event['response']
    elif shape in ('mapping', 'json_mapping'):
        try:
            value = raw if isinstance(raw, dict) else json.loads(raw)
            event_type = value.get('type')
            if isinstance(event_type, str) and event_type in EVENT_TYPES:
                counts[event_type] += 1
            elif event_type is not None:
                other_events += 1
            nested = value.get('response')
            terminal = nested if isinstance(nested, dict) else value
        except Exception:
            # Never render parsing exceptions; they can contain provider data.
            parse_error_count += 1

    output = terminal.get('output') if isinstance(terminal, dict) else None
    details = terminal.get('incomplete_details') if isinstance(terminal, dict) else None
    reason = details.get('reason') if isinstance(details, dict) else None
    return {
        'diagnostic': 'empty_responses_api_output' if output == [] else 'responses_api_observation',
        'phase': phase if phase in ('failure', 'post_api_call', 'startup') else 'other',
        'raw_shape': shape,
        'event_counts': {name: counts[name] for name in sorted(counts)},
        'other_event_count': other_events,
        'parse_error_count': parse_error_count,
        'output_item_count': len(output) if isinstance(output, list) else None,
        'input_truncated': input_truncated,
        'response_status': _allowed(terminal.get('status'), RESPONSE_STATUSES) if isinstance(terminal, dict) else None,
        'incomplete_reason': _allowed(reason, INCOMPLETE_REASONS),
    }


def _capture_response(raw):
    enabled = os.environ.get('CIRCUS_LITELLM_CAPTURE_RESPONSE', 'false').lower() == 'true'
    result = {'capture_enabled': enabled, 'capture_written': False, 'capture_truncated': False}
    if not enabled:
        return result
    if isinstance(raw, str):
        body = raw
    elif isinstance(raw, (dict, list)):
        try:
            body = json.dumps(raw, ensure_ascii=False, separators=(',', ':'))
        except (TypeError, ValueError):
            return result
    else:
        return result
    result['capture_truncated'] = len(body) > MAX_RAW_CHARACTERS
    body = body[-MAX_RAW_CHARACTERS:]
    try:
        descriptor = os.open(RESPONSE_BODY_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                descriptor = -1
                output.write(body)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        result['capture_written'] = True
    except (OSError, UnicodeError):
        pass
    return result


def _publish(summary):
    encoded = json.dumps(summary, separators=(',', ':'), sort_keys=True)
    try:
        DIAGNOSTIC_PATH.write_text(encoded + '\n')
    except Exception:
        pass
    try:
        print('Circus LiteLLM diagnostic: ' + encoded, file=sys.stderr, flush=True)
    except Exception:
        pass


class ResponseDiagnostics(CustomLogger):
    def __init__(self):
        super().__init__(turn_off_message_logging=True)
        _publish(summarize_response(None, 'startup'))

    def log_post_api_call(self, kwargs, response_obj, start_time, end_time):
        try:
            raw = kwargs.get('original_response')
            summary = summarize_response(raw, 'post_api_call')
            summary.update(_capture_response(raw))
            _publish(summary)
        except Exception:
            return

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            raw = kwargs.get('original_response')
            summary = summarize_response(raw, 'failure')
            summary.update(_capture_response(raw))
            _publish(summary)
        except Exception:
            return

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self.log_failure_event(kwargs, response_obj, start_time, end_time)


response_diagnostics = ResponseDiagnostics()

"""Backport reviewed ChatGPT Responses fixes to the pinned LiteLLM image."""
import hashlib
from pathlib import Path


paths = list(Path('/app/.venv/lib').glob('python*/site-packages/litellm/llms/custom_httpx/llm_http_handler.py'))
if len(paths) != 1:
    raise SystemExit('Expected one pinned LiteLLM HTTP handler.')

path = paths[0]
source = path.read_text()
expected_digest = 'c077f9c7aa20108e6e0efd3b9bcc6c03c329ab3541423a2b89622419aa84da7b'
if hashlib.sha256(source.encode()).hexdigest() != expected_digest:
    raise SystemExit('Pinned LiteLLM HTTP handler does not match the reviewed source.')
old = '        stream = bool(stream or data.get("stream"))\n'
new = (
    '        stream = (bool(stream) if custom_llm_provider == "chatgpt" '
    'else bool(stream or data.get("stream")))\n'
)
if source.count(old) != 2:
    raise SystemExit('Pinned LiteLLM stream semantics no longer match the reviewed source.')
path.write_text(source.replace(old, new))


paths = list(Path('/app/.venv/lib').glob(
    'python*/site-packages/litellm/completion_extras/'
    'litellm_responses_transformation/transformation.py'))
if len(paths) != 1:
    raise SystemExit('Expected one pinned LiteLLM Responses transformation.')

path = paths[0]
source = path.read_text()
expected_digest = 'dafcbb0a04bc80b408977be9a038a4075467917792084c84fd3391e238b6fbf9'
if hashlib.sha256(source.encode()).hexdigest() != expected_digest:
    raise SystemExit('Pinned LiteLLM Responses transformation does not match the reviewed source.')
old = '''        if accumulated_tool_calls:
            msg = Message(
                content=None,
                tool_calls=accumulated_tool_calls,
                reasoning_content=reasoning_content,
                reasoning_items=cast(
                    list[ChatCompletionReasoningItem] | None,
                    ([pending_reasoning_item] if pending_reasoning_item is not None else None),
                ),
            )
            choices.append(Choices(message=msg, finish_reason="tool_calls", index=index))
            reasoning_content = None
            pending_reasoning_item = None

        return choices
'''
new = '''        if accumulated_tool_calls:
            msg = Message(
                content=None,
                tool_calls=accumulated_tool_calls,
                reasoning_content=reasoning_content,
                reasoning_items=cast(
                    list[ChatCompletionReasoningItem] | None,
                    ([pending_reasoning_item] if pending_reasoning_item is not None else None),
                ),
            )
            choices.append(Choices(message=msg, finish_reason="tool_calls", index=index))
            reasoning_content = None
            pending_reasoning_item = None

            # Responses output items are sequential parts of one assistant turn,
            # not Chat Completions alternatives. Preserve text emitted before a
            # function call on the single tool-call choice expected by chat clients.
            if len(choices) > 1:
                msg.content = "".join(
                    choice.message.content or "" for choice in choices[:-1]
                ) or None
                choices = [Choices(message=msg, finish_reason="tool_calls", index=0)]

        return choices
'''
if source.count(old) != 1:
    raise SystemExit('Pinned LiteLLM Responses choice conversion no longer matches the reviewed source.')
path.write_text(source.replace(old, new))

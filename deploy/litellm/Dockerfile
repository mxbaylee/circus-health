FROM docker.io/litellm/litellm:1.99.1@sha256:a53a7d3ffebede1925bd3ee8a21e4a7b9b63e2e68ec883af136edcccb6eeb82c

# Narrow, guarded compatibility fix for the pinned ChatGPT Responses route.
COPY patch_chatgpt_stream_semantics.py /tmp/patch_chatgpt_stream_semantics.py
RUN python /tmp/patch_chatgpt_stream_semantics.py && rm /tmp/patch_chatgpt_stream_semantics.py

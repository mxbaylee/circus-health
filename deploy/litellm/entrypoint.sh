#!/bin/sh
set -eu
umask 077
# LiteLLM treats even an empty DATABASE_URL as a request to initialize Prisma.
# This config-file deployment intentionally has no database or hosted callbacks.
unset DATABASE_URL DIRECT_URL STORE_MODEL_IN_DB LITELLM_CALLBACKS

key_file=/run/secrets/litellm_master_key
if [ ! -r "$key_file" ]; then
  echo 'LiteLLM master-key secret is unavailable.' >&2
  exit 1
fi
export LITELLM_MASTER_KEY="$(cat "$key_file")"
if [ -z "$LITELLM_MASTER_KEY" ]; then
  echo 'LiteLLM master-key secret is empty.' >&2
  exit 1
fi
python /opt/circus/configure.py
exec litellm --config /tmp/circus-litellm.yaml --host 0.0.0.0 --port 4000

#!/bin/sh
# Paperclip ACP launcher that tags every model request with the Paperclip run
# and task, so a gateway (LiteLLM) can attribute spend per run. Paperclip sets
# PAPERCLIP_RUN_ID / PAPERCLIP_TASK_ID for each run; Claude Code sends
# ANTHROPIC_CUSTOM_HEADERS on every request; LiteLLM records x-litellm-tags.
# Configure an agent with adapterConfig.agentCommand pointing at this file.
tags="paperclip-run:${PAPERCLIP_RUN_ID:-none}"
[ -n "${PAPERCLIP_TASK_ID:-}" ] && tags="$tags,paperclip-task:$PAPERCLIP_TASK_ID"
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-tags: $tags"
exec "${PAPERCLIP_REAL_ACP:-/app/packages/adapters/claude-local/node_modules/.bin/claude-agent-acp}" "$@"

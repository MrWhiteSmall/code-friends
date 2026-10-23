#!/bin/zsh
set -eu
export CODEX_FRIENDS_PROJECT_DIR=${0:A:h:h}
# Load the user's existing token/proxy setup without putting credentials in argv.
exec /bin/zsh -ic 'export TELEGRAM_TOKEN
exec node --use-env-proxy "$CODEX_FRIENDS_PROJECT_DIR/src/main.mjs"'

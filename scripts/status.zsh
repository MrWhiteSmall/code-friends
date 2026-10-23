#!/bin/zsh
set -eu
task_dir=${0:A:h:h}
exec node "$task_dir/scripts/service.mjs" status

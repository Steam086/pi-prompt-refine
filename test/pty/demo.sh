#!/usr/bin/env bash
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
box=$(mktemp -d)
trap 'rm -rf -- "$box"' EXIT
mkdir -p "$box/home" "$box/agent" "$box/project"
cat > "$box/agent/prompt-refine.json" <<'JSON'
{"version":1,"model":{"provider":"fixture","id":"writer"},"historyPersistence":false,"projectContext":{"enabled":false}}
JSON
case "${1:-dark}" in
  light|dark) printf '{"theme":"%s","showHardwareCursor":true}\n' "${1:-dark}" > "$box/agent/settings.json" ;;
  *) exit 2 ;;
esac
cd "$box/project"
env -i LANG=C.UTF-8 TERM="${TERM:-xterm-256color}" PATH="$PATH" HOME="$box/home" PI_CODING_AGENT_DIR="$box/agent" PI_OFFLINE=1 \
  REFINE_FIXTURE_LOG="${REFINE_FIXTURE_LOG:-}" REFINE_FIXTURE_CUSTOM_EDITOR="${REFINE_FIXTURE_CUSTOM_EDITOR:-0}" \
  "$root/node_modules/.bin/pi" --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools \
  -e "$root/test/pty/fixture-provider.ts" -e "$root/src/extension.ts" --model fixture/writer

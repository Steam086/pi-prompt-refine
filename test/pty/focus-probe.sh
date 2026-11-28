set -eu
root=$PWD
box=$(mktemp -d)
mkdir -p "$box/home" "$box/agent" "$box/project"
sock="$box/tmux"
t() { tmux -S "$sock" "$@"; }
trap 't kill-server 2>/dev/null || true' EXIT
t -f /dev/null new-session -d -x 80 -y 24 -c "$box/project" "env -i TERM=xterm-256color PATH='$PATH' HOME='$box/home' PI_CODING_AGENT_DIR='$box/agent' PI_OFFLINE=1 PROBE_LOG='$box/log' '$root/node_modules/.bin/pi' --no-session --no-extensions --no-skills --no-prompt-templates --no-themes -e '$root/test/pty/focus-probe.mjs'"
sleep 3
t capture-pane -p
t send-keys -l 'original'
t send-keys C-\\
sleep .5
t send-keys Enter Enter Up Down
sleep .2
t capture-pane -p
t send-keys Escape
sleep .4
t send-keys -l ' restored'
t send-keys C-\\
sleep .5
cat "$box/log"

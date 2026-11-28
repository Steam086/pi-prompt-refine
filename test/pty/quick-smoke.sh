#!/usr/bin/env bash
# Run from the repository root. Capture names describe the physical tmux pane.
set -eu
out=${1:?Pass an empty output directory for terminal captures}
theme=${2:-dark}
mkdir -p "$out"
out=$(cd "$out" && pwd)
box=$(mktemp -d)
sock=$box/tmux
t() { tmux -S "$sock" "$@"; }
trap 't kill-server 2>/dev/null || true; rm -rf -- "$box"' EXIT
t -f /dev/null new-session -d -x 120 -y 40 "REFINE_FIXTURE_LOG='$box/events' REFINE_FIXTURE_CUSTOM_EDITOR=1 bash test/pty/demo.sh '$theme'"
t set-option status off
t set-option -w window-size manual
t resize-window -x 120 -y 40
key() { t send-keys "$@"; }
screen() { t capture-pane -p; }
wait_for() {
  for ((i=0; i<100; i++)); do
    if screen | rg -Fq -- "$1"; then return; fi
    sleep .08
  done
  screen >&2
  return 1
}
capture() {
  screen > "$out/$1.txt"
  t display-message -p "$1 #{pane_width}x#{pane_height} hardware-cursor=#{cursor_flag}" >> "$out/geometry.txt"
  if [[ -n ${REFINE_CAPTURE_HOOK:-} ]]; then "$REFINE_CAPTURE_HOOK" "$sock" "$out/$1.png" "$theme"; fi
}
> "$out/geometry.txt"
wait_for 'Use Ctrl'
capture hidden
key C-\\
wait_for 'Type a prompt first.'
key -l '/fixture-modal'
key Enter
wait_for 'Fixture selector'
key C-\\
wait_for 'Fixture selector'
key Escape
sleep .25
key -l 'Review scheduling'
key C-\\
wait_for 'Generating'
key Enter Enter Escape
wait_for '1 running'
capture background
wait_for '1 ready'
key C-\\
wait_for 'a Accept'
capture short
key Enter Enter
sleep .15
wait_for 'a Accept'
[[ $(rg -c '^fixture stream$' "$box/events") == 1 ]]
! rg -q '^user message_start' "$box/events" || exit 1
key a
sleep .22
capture accepted
key Enter
wait_for 'Review the scheduling design'
for ((i=0; i<60 && $(rg -c '^user message_start' "$box/events" || echo 0) == 0; i++)); do sleep .05; done
[[ $(rg -c '^user message_start' "$box/events") == 1 ]]
sleep 1.6
key -l '/fixture-overlay'
key Enter
sleep .18
key -l 'Long fixture'
key C-\\
wait_for 'Lines 1'
capture long
wait_for 'Fixture overlay'
key C-\\ a Enter
sleep .15
wait_for 'Fixture overlay'
key Escape
sleep .18
wait_for 'a Accept'
key f
wait_for 'Additional requirements'
key -l 'Preserve the tables.'
capture revision
key Escape
wait_for 'a Accept'
key PageDown
sleep .13
capture scrolled
key v
wait_for 'Full preview'
capture expanded
key Escape
sleep .18
for pair in 80x24 160x50 240x60 48x18 40x12; do
  t resize-window -x "${pair%x*}" -y "${pair#*x}"
  sleep .18
  wait_for 'a Accept'
  capture "ready-$pair"
done
key Escape
sleep .25
key -l 'afnwxv'
sleep .1
wait_for 'Long fixtureafnwxv'
[[ $(rg -c '^fixture stream$' "$box/events") == 3 ]]
key C-u
t resize-window -x 80 -y 24
for ((i=0; i<18; i++)); do printf '  paste %s 中文\n' "$i"; done > "$box/paste"
printf '  end  ' >> "$box/paste"
t load-buffer "$box/paste"
t paste-buffer -p
sleep .2
key C-\\
wait_for 'a Accept'
rg -q '^expanded paste matched$' "$box/events"
key Escape
sleep .18
key C-\\
wait_for 'a Accept'
[[ $(rg -c '^fixture stream$' "$box/events") == 4 ]]
[[ $(rg -c '^user message_start' "$box/events") == 1 ]]
cp "$box/events" "$out/events.txt"

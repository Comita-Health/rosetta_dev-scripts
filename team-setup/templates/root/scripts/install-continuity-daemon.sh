#!/usr/bin/env bash
# Install (or refresh) the launchd continuity daemon.
#
# launchd is the point: a watcher started from an agent tool call dies with
# that call, and a `while true` loop in a chat terminal dies with the chat.
# launchd keeps ticking across turns, terminal closes, and reboots — which is
# the only way the loop survives the human walking away.
#
#   bash scripts/install-continuity-daemon.sh            # install + start
#   bash scripts/install-continuity-daemon.sh --uninstall
set -euo pipefail

LABEL="com.rosetta.sdlc-daemon"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="$SCRIPT_DIR/sdlc-continuity-daemon.sh"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
INTERVAL="${SDLC_DAEMON_INTERVAL:-60}"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  [[ -f "$PLIST" ]] && mv "$PLIST" "${PLIST}.removed"
  echo "Uninstalled ${LABEL}."
  exit 0
fi

if [[ ! -f "$DAEMON" ]]; then
  echo "install-continuity-daemon: missing $DAEMON" >&2
  exit 1
fi
chmod +x "$DAEMON"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.rosetta"

# launchd gives a job a minimal PATH, so `gh`, `bun`, and `python3` would all
# be missing. Freeze the installing shell's PATH into the plist.
cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${DAEMON}</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${HOME}/.rosetta/sdlc-daemon.out.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.rosetta/sdlc-daemon.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}"

echo "Installed ${LABEL} (every ${INTERVAL}s)."
echo "  plist:  $PLIST"
echo "  daemon: $DAEMON"
echo "  log:    $HOME/.rosetta/sdlc-daemon.log"
echo
echo "Status:  launchctl print gui/$(id -u)/${LABEL} | head -20"

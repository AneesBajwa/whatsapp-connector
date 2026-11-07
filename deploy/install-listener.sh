#!/usr/bin/env bash
# Install (or repair) the WhatsApp listener's systemd unit and make sure it runs.
#
# Why: /etc is not persistent on the VM. A VM replacement wipes
# /etc/systemd/system/muse-whatsapp-listener.service and its enable link, so
# nothing starts the listener again. This script lives in the connector
# folder (persistent) and puts both back. Wire it into the runtime's start-up
# hook so it runs once at every boot (see HANDOFF-VM.md); it is not a poller.
#
# deploy/muse-whatsapp-listener.service is the source of truth for the unit.
# A missing unit is installed from it. A unit in /etc that differs from it is
# reported and left alone unless --force is given (then it is replaced and
# the service restarted), so a deliberate change in /etc is never lost silently.
#
# Idempotent: when the unit is installed, enabled and running, it changes
# nothing and writes no event. Run as root.
#
#   deploy/install-listener.sh [--reason boot|cli|manual] [--force] [--cli-fallback]
#
#   --reason        recorded in the events and the log (default: boot)
#   --force         replace a unit in /etc that differs from deploy/, and restart
#   --cli-fallback  also create listener.autostart, so a CLI command that finds
#                   no listener runs this script before going one-shot
#
# Events (requests/, Kind: lifecycle):
#   listener-installed  it installed the unit and/or started the service
#   unit-differs        /etc has a different unit; left alone (no --force)
#   install-failed      it could not get the listener running; written at most
#                       once per reason every 6 hours, so repeated runs (CLI
#                       fallback) do not flood Muse
# The listener's own "started" event follows once it is up.
#
# Overrides for tests: UNIT_DIR (default /etc/systemd/system), SYSTEMCTL
# (default systemctl), SOCKET_WAIT_S (default 45).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=muse-whatsapp-listener
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
DEST="$UNIT_DIR/$UNIT.service"
SRC="$ROOT/deploy/$UNIT.service"
LOG="$ROOT/deploy/install-listener.log"
SOCKET="$ROOT/listener.sock"
SOCKET_WAIT_S="${SOCKET_WAIT_S:-45}"
FAILURE_STATE="$ROOT/deploy/.install-listener.last-failure"
DIFFERS_STATE="$ROOT/deploy/.install-listener.last-differs"
FAILURE_QUIET_S=$((6 * 3600))
REASON=boot
FORCE=0
CLI_FALLBACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then echo "--reason needs a value" >&2; exit 2; fi
      REASON="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --cli-fallback) CLI_FALLBACK=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

umask 077
T0=$(date +%s)
log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REASON" "$*" >> "$LOG"; echo "$*" >&2; }

UNIT_TEXT="$(cat "$SRC" 2>/dev/null || true)"
# node: from the unit's own ExecStart (deploy/ first, then the installed one),
# and only then from PATH. Boot hooks, sudo and the CLI fallback each have a
# different PATH; reading the unit keeps every caller on the same node.
exec_node() { sed -n 's/^ExecStart=\([^ <][^ ]*\) .*/\1/p' | head -n1; }
NODE="$(printf '%s\n' "$UNIT_TEXT" | exec_node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then NODE="$(exec_node < "$DEST" 2>/dev/null || true)"; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi

event() { # event <name> <title> <notify:0|1> <line>...
  local name="$1" title="$2" notify="$3"; shift 3
  [ -n "$NODE" ] || { log "cannot write the $name event: node not found"; return; }
  local args=(--event "$name" --title "$title")
  [ "$notify" = 1 ] && args+=(--notify)
  for l in "$@"; do args+=(--line "$l"); done
  "$NODE" "$ROOT/bin/lifecycle-event.cjs" "${args[@]}" >/dev/null 9>&- || log "could not write the $name event"
}
fail() {
  log "FAILED: $1"
  # The same failure again within 6 hours: logged, not re-announced.
  local last_reason="" last_at=0 now
  now=$(date +%s)
  if [ -f "$FAILURE_STATE" ]; then IFS=$'\t' read -r last_at last_reason < "$FAILURE_STATE" || true; fi
  if [ "$last_reason" != "$1" ] || [ $((now - ${last_at:-0})) -ge "$FAILURE_QUIET_S" ]; then
    printf '%s\t%s\n' "$now" "$1" > "$FAILURE_STATE"
    event install-failed "WhatsApp listener could not be started" 1 \
      "deploy/install-listener.sh ($REASON) could not get the listener running: $1" \
      "Until this is fixed, nothing watches for @agent prompts. Details: deploy/install-listener.log and journalctl -u $UNIT -n 50" \
      "The same failure is not announced again for 6 hours."
  fi
  exit 1
}

# One run at a time (boot hook and CLI fallback may race).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/deploy/.install-listener.lock"
  flock -w 120 9 || fail "another install-listener run did not finish in 120 s"
fi

command -v "$SYSTEMCTL" >/dev/null 2>&1 || fail "systemctl not found: this machine has no systemd to supervise the listener"
[ -f "$ROOT/auth/creds.json" ] || fail "no linked session in auth/ (the listener never pairs; link the device first)"
[ -n "$UNIT_TEXT" ] || fail "missing $SRC"

# A copy with <...> placeholders on its four settings is filled in from this machine.
PLACEHOLDER='^(User|WorkingDirectory|EnvironmentFile|ExecStart)=.*<[^>]*>'
if printf '%s\n' "$UNIT_TEXT" | grep -Eq "$PLACEHOLDER"; then
  [ -n "$NODE" ] || fail "node not found, and $SRC still has <...> placeholders"
  OWNER="$(stat -c %U "$ROOT" 2>/dev/null || stat -f %Su "$ROOT")"
  UNIT_TEXT="$(printf '%s\n' "$UNIT_TEXT" | sed \
    -e "s|^User=<[^>]*>|User=$OWNER|" \
    -e "s|^WorkingDirectory=<[^>]*>|WorkingDirectory=$ROOT|" \
    -e "s|^EnvironmentFile=-<[^>]*>/listener.env|EnvironmentFile=-$ROOT/listener.env|" \
    -e "s|^ExecStart=<[^>]*> |ExecStart=$NODE |")"
  printf '%s\n' "$UNIT_TEXT" | grep -Eq "$PLACEHOLDER" && fail "could not fill every <...> value in $SRC"
fi

CHANGED=()
RESTART=0
if [ ! -f "$DEST" ]; then
  CHANGED+=("the unit file was missing from $UNIT_DIR (the VM was replaced, or /etc was reset)")
  mkdir -p "$UNIT_DIR"
  printf '%s\n' "$UNIT_TEXT" > "$DEST.tmp.$$" && chmod 644 "$DEST.tmp.$$" && mv "$DEST.tmp.$$" "$DEST" || fail "could not write $DEST"
  "$SYSTEMCTL" daemon-reload || fail "systemctl daemon-reload failed"
elif [ "$(cat "$DEST")" != "$UNIT_TEXT" ]; then
  if [ "$FORCE" = 1 ]; then
    CHANGED+=("the unit in $UNIT_DIR differed from deploy/ and was replaced (--force)")
    printf '%s\n' "$UNIT_TEXT" > "$DEST.tmp.$$" && chmod 644 "$DEST.tmp.$$" && mv "$DEST.tmp.$$" "$DEST" || fail "could not write $DEST"
    "$SYSTEMCTL" daemon-reload || fail "systemctl daemon-reload failed"
    RESTART=1
  else
    log "the unit in $UNIT_DIR differs from deploy/; left alone (use --force to replace it)"
    # Announced once per difference every 6 hours, like failures.
    SIG="$(cksum < "$DEST" | cut -d' ' -f1)-$(printf '%s\n' "$UNIT_TEXT" | cksum | cut -d' ' -f1)"
    LAST_SIG="" LAST_AT=0 NOW=$(date +%s)
    if [ -f "$DIFFERS_STATE" ]; then IFS=$'\t' read -r LAST_AT LAST_SIG < "$DIFFERS_STATE" || true; fi
    if [ "$LAST_SIG" != "$SIG" ] || [ $((NOW - ${LAST_AT:-0})) -ge "$FAILURE_QUIET_S" ]; then
      printf '%s\t%s\n' "$NOW" "$SIG" > "$DIFFERS_STATE"
      event unit-differs "WhatsApp listener unit differs from deploy/" 1 \
        "$DEST is not the same as deploy/$UNIT.service, the copy that survives a VM replacement." \
        "It was left alone. Copy the change you want to keep into deploy/$UNIT.service, then run: sudo deploy/install-listener.sh --reason manual --force"
    fi
  fi
fi
if ! "$SYSTEMCTL" is-enabled --quiet "$UNIT" 2>/dev/null; then
  "$SYSTEMCTL" enable "$UNIT" >/dev/null 2>&1 || fail "systemctl enable $UNIT failed"
  CHANGED+=("the service was not enabled")
fi

STARTED=0
STAMP="$ROOT/deploy/.install-listener.stamp"
if ! "$SYSTEMCTL" is-active --quiet "$UNIT"; then
  CHANGED+=("the service was not running")
  # The listener recreates listener.sock when it starts; a socket left over
  # from before (the home folder outlives the VM) must not count as "up".
  touch "$STAMP"; sleep 1
  # 9>&-: the service must not inherit this script's lock.
  "$SYSTEMCTL" start "$UNIT" 9>&- || fail "systemctl start $UNIT failed"
  STARTED=1
elif [ "$RESTART" = 1 ]; then
  touch "$STAMP"; sleep 1
  "$SYSTEMCTL" try-restart "$UNIT" 9>&- || fail "systemctl try-restart $UNIT failed"
  CHANGED+=("the service was restarted to apply the new unit")
  STARTED=1
fi

if [ "$CLI_FALLBACK" = 1 ]; then
  # An empty marker: the CLI runs this script (fixed path) when it finds no listener.
  : > "$ROOT/listener.autostart" && chmod 644 "$ROOT/listener.autostart"
  log "CLI fallback enabled (listener.autostart)"
fi

if [ ${#CHANGED[@]} -eq 0 ]; then
  log "nothing to do: installed, enabled and running"
  exit 0
fi

# Wait for the listener's control socket: it exists once the listener runs.
socket_up() {
  [ -S "$SOCKET" ] || return 1
  [ "$STARTED" = 0 ] && return 0
  [ -n "$(find "$SOCKET" -newer "$STAMP" 2>/dev/null)" ]
}
for _ in $(seq 1 "$SOCKET_WAIT_S"); do
  socket_up && break
  sleep 1
done
socket_up || fail "the service started but listener.sock did not appear within ${SOCKET_WAIT_S}s"
rm -f "$FAILURE_STATE"

TOOK=$(( $(date +%s) - T0 ))
log "listener up after ${TOOK}s: ${CHANGED[*]}"
if [ "$STARTED" = 1 ]; then SUMMARY="brought the WhatsApp listener back in ${TOOK}s."; else SUMMARY="repaired the listener's setup; the listener itself was already running."; fi
LINES=("deploy/install-listener.sh ($REASON) $SUMMARY")
for c in "${CHANGED[@]}"; do LINES+=("- $c"); done
[ "$STARTED" = 1 ] && LINES+=("The listener's own started event says how long nothing was listening.")
event listener-installed "WhatsApp listener reinstalled and started" 0 "${LINES[@]}"
exit 0

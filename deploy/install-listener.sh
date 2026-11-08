#!/usr/bin/env bash
# Install (or repair) the WhatsApp listener's systemd unit and make sure it runs.
#
# Two scopes:
#   system (default until --scope user is chosen): the unit goes in
#     /etc/systemd/system. /etc is not persistent on the VM: a VM replacement
#     wipes the unit and its enable link, so something must run this script
#     again after every replacement.
#   user (--scope user, as the folder's owner): the unit and its enable link
#     go in ~/.config/systemd/user, in the home folder, which survives a VM
#     replacement. With lingering on (checked and turned on here), the user's
#     systemd starts at boot and starts the listener, and nothing has to watch
#     it. Lingering itself is recorded in /var/lib/systemd/linger/: if a VM
#     replacement resets that too, one run of this script at boot (as root or
#     the owner) turns it back on and starts the listener.
# The scope given last is remembered (deploy/.listener-scope), so a later run
# without --scope (a boot hook, the CLI fallback) uses the same one. Run as
# root, a user-scope run continues as the folder's owner.
#
# deploy/muse-whatsapp-listener.service (system) and
# deploy/muse-whatsapp-listener.user.service (user) are the source of truth.
# A missing unit is installed from it. An installed unit that differs is
# reported and left alone unless --force is given (then it is replaced and the
# service restarted), so a deliberate change is never lost silently.
#
# Idempotent: when the unit is installed, enabled and running, it changes
# nothing and writes no event.
#
#   deploy/install-listener.sh [--scope system|user] [--reason boot|cli|manual] [--force] [--cli-fallback]
#
#   --scope         system or user (default: the remembered scope, else system)
#   --reason        recorded in the events and the log (default: boot)
#   --force         replace an installed unit that differs from deploy/, and restart
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
# Overrides for tests: UNIT_DIR (default /etc/systemd/system, or
# ~/.config/systemd/user in user scope), USER_UNIT_DIR (the owner's
# ~/.config/systemd/user, checked in system scope), SYSTEMCTL (default
# systemctl), LOGINCTL (default loginctl), RUNUSER (default runuser),
# SOCKET_WAIT_S (default 45), USER_MANAGER_WAIT_S (default 15).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=muse-whatsapp-listener
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LOGINCTL="${LOGINCTL:-loginctl}"
LOG="$ROOT/deploy/install-listener.log"
SOCKET="$ROOT/listener.sock"
SOCKET_WAIT_S="${SOCKET_WAIT_S:-45}"
USER_MANAGER_WAIT_S="${USER_MANAGER_WAIT_S:-15}"
# runuser is in /usr/sbin, which a boot hook's or cron's PATH may not include.
if [ -z "${RUNUSER:-}" ]; then
  RUNUSER="$(command -v runuser 2>/dev/null || true)"
  for c in /usr/sbin/runuser /sbin/runuser; do if [ -z "$RUNUSER" ] && [ -x "$c" ]; then RUNUSER="$c"; fi; done
  RUNUSER="${RUNUSER:-runuser}"
fi
FAILURE_STATE="$ROOT/deploy/.install-listener.last-failure"
DIFFERS_STATE="$ROOT/deploy/.install-listener.last-differs"
SCOPE_FILE="$ROOT/deploy/.listener-scope"
FAILURE_QUIET_S=$((6 * 3600))
ORIG_ARGS=("$@")
REASON=boot
FORCE=0
CLI_FALLBACK=0
SCOPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then echo "--reason needs a value" >&2; exit 2; fi
      REASON="$2"; shift 2 ;;
    --scope)
      if [ $# -lt 2 ] || { [ "$2" != system ] && [ "$2" != user ]; }; then echo "--scope needs system or user" >&2; exit 2; fi
      SCOPE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --cli-fallback) CLI_FALLBACK=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
SCOPE_GIVEN=0
if [ -n "$SCOPE" ]; then SCOPE_GIVEN=1; else SCOPE="$(cat "$SCOPE_FILE" 2>/dev/null || true)"; fi
[ "$SCOPE" = user ] || SCOPE=system
OWNER="$(stat -c %U "$ROOT" 2>/dev/null || stat -f %Su "$ROOT")"
OWNER_UID="$(id -u "$OWNER" 2>/dev/null || echo 0)"
OWNER_HOME="$(getent passwd "$OWNER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$OWNER_HOME" ] || OWNER_HOME="$(eval echo "~$OWNER")"
# Root running for a folder someone else owns: what it leaves in the folder
# must stay the owner's, or a later run as the owner (user scope) cannot use it.
AS_OWNER=()
STATE_FILES=("$ROOT/deploy/.install-listener.lock" "$FAILURE_STATE" "$DIFFERS_STATE" "$ROOT/deploy/.install-listener.stamp" "$LOG" "$SCOPE_FILE")
own_state() { local f; for f in "${STATE_FILES[@]}"; do if [ -e "$f" ]; then chown "$OWNER" "$f" 2>/dev/null || true; fi; done; }
if [ "$(id -u)" = 0 ] && [ "$OWNER_UID" != 0 ]; then
  if command -v "$RUNUSER" >/dev/null 2>&1; then AS_OWNER=("$RUNUSER" -u "$OWNER" --); fi
  trap own_state EXIT
fi

if [ "$SCOPE" = user ] && [ "$(id -u)" = 0 ] && [ "$OWNER_UID" != 0 ]; then
  # The owner's systemd, not root's: continue as the folder's owner (unless
  # the folder belongs to root, whose own user systemd is then the one used).
  [ ${#AS_OWNER[@]} -gt 0 ] || { echo "user scope as root needs $RUNUSER to continue as $OWNER" >&2; exit 1; }
  # Files earlier root runs left (mode 0600) must be the owner's, or the run below cannot use them.
  own_state
  # Lingering first: without it the owner's systemd may not be running at all.
  if [ "$("$LOGINCTL" show-user "$OWNER" --property=Linger --value 2>/dev/null)" != yes ]; then
    "$LOGINCTL" enable-linger "$OWNER" >/dev/null 2>&1 || true
  fi
  exec "${AS_OWNER[@]}" env HOME="$OWNER_HOME" XDG_RUNTIME_DIR="/run/user/$OWNER_UID" \
    PATH="$PATH" SYSTEMCTL="$SYSTEMCTL" LOGINCTL="$LOGINCTL" SOCKET_WAIT_S="$SOCKET_WAIT_S" USER_MANAGER_WAIT_S="$USER_MANAGER_WAIT_S" \
    ${UNIT_DIR:+UNIT_DIR="$UNIT_DIR"} bash "${BASH_SOURCE[0]}" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"} --scope user
fi
USER_UNIT_DIR="${USER_UNIT_DIR:-$OWNER_HOME/.config/systemd/user}"

if [ "$SCOPE" = user ]; then
  UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
  SRC="$ROOT/deploy/$UNIT.user.service"
  SC=("$SYSTEMCTL" --user)
  JOURNAL="journalctl --user -u $UNIT -n 50"
  # Needed to reach the user's systemd from a boot hook, cron or sudo.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
else
  UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
  SRC="$ROOT/deploy/$UNIT.service"
  SC=("$SYSTEMCTL")
  JOURNAL="journalctl -u $UNIT -n 50"
fi
DEST="$UNIT_DIR/$UNIT.service"

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
  # As the folder's owner when root runs this: the event file, its push marker
  # and the wake command it runs belong to the owner, as the listener's do.
  ${AS_OWNER[@]+"${AS_OWNER[@]}"} "$NODE" "$ROOT/bin/lifecycle-event.cjs" "${args[@]}" >/dev/null 9>&- || log "could not write the $name event"
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
      "deploy/install-listener.sh ($REASON, $SCOPE scope) could not get the listener running: $1" \
      "Until this is fixed, nothing watches for @agent prompts. Details: deploy/install-listener.log and $JOURNAL" \
      "The same failure is not announced again for 6 hours."
  fi
  exit 1
}

# One run at a time (boot hook and CLI fallback may race).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/deploy/.install-listener.lock" || fail "cannot open deploy/.install-listener.lock (owned by another user? chown it to $OWNER)"
  flock -w 120 9 || fail "another install-listener run did not finish in 120 s"
fi

command -v "$SYSTEMCTL" >/dev/null 2>&1 || fail "systemctl not found: this machine has no systemd to supervise the listener"
[ -f "$ROOT/auth/creds.json" ] || fail "no linked session in auth/ (the listener never pairs; link the device first)"
[ -n "$UNIT_TEXT" ] || fail "missing $SRC"
if [ "$SCOPE_GIVEN" = 1 ]; then printf '%s\n' "$SCOPE" > "$SCOPE_FILE" || fail "could not write $SCOPE_FILE"; fi

CHANGED=()
# Two supervisors would fight over the one session: one scope at a time.
if [ "$SCOPE" = user ]; then
  if "$SYSTEMCTL" is-active --quiet "$UNIT" 2>/dev/null || "$SYSTEMCTL" is-enabled --quiet "$UNIT" 2>/dev/null; then
    fail "the system-scope listener ($UNIT in /etc/systemd/system) is running or enabled; stop and disable it first: sudo systemctl disable --now $UNIT"
  fi
  # Without lingering the user's systemd starts only at a login, not at boot,
  # and may not be running now: turn it on first.
  ME="$(id -un)"
  if [ "$("$LOGINCTL" show-user "$ME" --property=Linger --value 2>/dev/null)" != yes ]; then
    "$LOGINCTL" enable-linger "$ME" >/dev/null 2>&1 || sudo -n "$LOGINCTL" enable-linger "$ME" >/dev/null 2>&1 || true
    [ "$("$LOGINCTL" show-user "$ME" --property=Linger --value 2>/dev/null)" = yes ] \
      || fail "lingering is off for $ME and could not be turned on (loginctl enable-linger $ME): without it the listener starts only when $ME logs in, not at boot"
    CHANGED+=("lingering was off for $ME, so nothing would have started the listener at boot")
  fi
  # The user's systemd comes up once lingering is on: a bounded wait for it.
  for _ in $(seq 1 "$USER_MANAGER_WAIT_S"); do "${SC[@]}" show-environment >/dev/null 2>&1 && break; sleep 1; done
  "${SC[@]}" show-environment >/dev/null 2>&1 || fail "cannot reach this user's systemd (systemctl --user, XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR): user services are not available here"
elif [ -e "$USER_UNIT_DIR/default.target.wants/$UNIT.service" ] || [ -L "$USER_UNIT_DIR/default.target.wants/$UNIT.service" ]; then
  fail "the user-scope listener is enabled for $OWNER ($USER_UNIT_DIR); as $OWNER, remove it first: systemctl --user disable --now $UNIT"
fi

# A copy with <...> placeholders on its four settings is filled in from this machine.
PLACEHOLDER='^(User|WorkingDirectory|EnvironmentFile|ExecStart)=.*<[^>]*>'
if printf '%s\n' "$UNIT_TEXT" | grep -Eq "$PLACEHOLDER"; then
  [ -n "$NODE" ] || fail "node not found, and $SRC still has <...> placeholders"
  UNIT_TEXT="$(printf '%s\n' "$UNIT_TEXT" | sed \
    -e "s|^User=<[^>]*>|User=$OWNER|" \
    -e "s|^WorkingDirectory=<[^>]*>|WorkingDirectory=$ROOT|" \
    -e "s|^EnvironmentFile=-<[^>]*>/listener.env|EnvironmentFile=-$ROOT/listener.env|" \
    -e "s|^ExecStart=<[^>]*> |ExecStart=$NODE |")"
  printf '%s\n' "$UNIT_TEXT" | grep -Eq "$PLACEHOLDER" && fail "could not fill every <...> value in $SRC"
fi

RESTART=0
if [ ! -f "$DEST" ]; then
  if [ "$SCOPE" = user ]; then CHANGED+=("the unit file was not installed in $UNIT_DIR yet")
  else CHANGED+=("the unit file was missing from $UNIT_DIR (the VM was replaced, or /etc was reset)"); fi
  mkdir -p "$UNIT_DIR"
  printf '%s\n' "$UNIT_TEXT" > "$DEST.tmp.$$" && chmod 644 "$DEST.tmp.$$" && mv "$DEST.tmp.$$" "$DEST" || fail "could not write $DEST"
  "${SC[@]}" daemon-reload || fail "systemctl daemon-reload failed"
elif [ "$(cat "$DEST")" != "$UNIT_TEXT" ]; then
  if [ "$FORCE" = 1 ]; then
    CHANGED+=("the unit in $UNIT_DIR differed from deploy/ and was replaced (--force)")
    printf '%s\n' "$UNIT_TEXT" > "$DEST.tmp.$$" && chmod 644 "$DEST.tmp.$$" && mv "$DEST.tmp.$$" "$DEST" || fail "could not write $DEST"
    "${SC[@]}" daemon-reload || fail "systemctl daemon-reload failed"
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
        "$DEST is not the same as deploy/$(basename "$SRC"), the copy that survives a VM replacement." \
        "It was left alone. Copy the change you want to keep into deploy/$(basename "$SRC"), then run: deploy/install-listener.sh --scope $SCOPE --reason manual --force"
    fi
  fi
fi
if ! "${SC[@]}" is-enabled --quiet "$UNIT" 2>/dev/null; then
  "${SC[@]}" enable "$UNIT" >/dev/null 2>&1 || fail "systemctl enable $UNIT failed"
  CHANGED+=("the service was not enabled")
fi

STARTED=0
STAMP="$ROOT/deploy/.install-listener.stamp"
if ! "${SC[@]}" is-active --quiet "$UNIT"; then
  CHANGED+=("the service was not running")
  # The listener recreates listener.sock when it starts; a socket left over
  # from before (the home folder outlives the VM) must not count as "up".
  touch "$STAMP"; sleep 1
  # 9>&-: the service must not inherit this script's lock.
  "${SC[@]}" start "$UNIT" 9>&- || fail "systemctl start $UNIT failed"
  STARTED=1
elif [ "$RESTART" = 1 ]; then
  touch "$STAMP"; sleep 1
  "${SC[@]}" try-restart "$UNIT" 9>&- || fail "systemctl try-restart $UNIT failed"
  CHANGED+=("the service was restarted to apply the new unit")
  STARTED=1
fi

if [ "$CLI_FALLBACK" = 1 ]; then
  # An empty marker: the CLI runs this script (fixed path) when it finds no listener.
  : > "$ROOT/listener.autostart" && chmod 644 "$ROOT/listener.autostart"
  log "CLI fallback enabled (listener.autostart)"
fi

if [ ${#CHANGED[@]} -eq 0 ]; then
  log "nothing to do: installed, enabled and running ($SCOPE scope)"
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
LINES=("deploy/install-listener.sh ($REASON, $SCOPE scope) $SUMMARY")
for c in "${CHANGED[@]}"; do LINES+=("- $c"); done
[ "$STARTED" = 1 ] && LINES+=("The listener's own started event says how long nothing was listening.")
event listener-installed "WhatsApp listener reinstalled and started" 0 "${LINES[@]}"
exit 0

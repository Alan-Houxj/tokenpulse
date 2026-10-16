#!/usr/bin/env bash
set -euo pipefail

PLATFORM="$1"
ARCH="$2"
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tokenpulse-smoke-${PLATFORM}-${ARCH}-XXXXXX")
SMOKE="$WORK/marks"
LOG="$WORK/app.log"
mkdir -p "$SMOKE"
export TOKENPULSE_SMOKE_DIR="$SMOKE"
APP_PID=''
BUNDLE=''
MOUNT=''

cleanup() {
  if [ "$PLATFORM" = macos ] && [ -n "$BUNDLE" ]; then
    pgrep -f "$BUNDLE/Contents/MacOS/TokenPulse" > "$WORK/pids.txt" || true
    while IFS= read -r pid; do
      kill -TERM "$pid" 2>/dev/null || true
    done < "$WORK/pids.txt"
    sleep 2
    while IFS= read -r pid; do
      kill -KILL "$pid" 2>/dev/null || true
    done < "$WORK/pids.txt"
    if [ -n "$MOUNT" ]; then hdiutil detach "$MOUNT" > "$WORK/detach.log" 2>&1 || true; fi
  elif [ "$PLATFORM" = windows ]; then
    if [ -n "$APP_PID" ]; then kill "$APP_PID" 2>/dev/null || true; fi
    MSYS_NO_PATHCONV=1 taskkill /IM TokenPulse.exe /T /F > "$WORK/cleanup.log" 2>&1 || true
  elif [ -n "$APP_PID" ]; then
    kill -- "-$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

VERSION=$(node -p 'require("./package.json").version')
if [ "$PLATFORM" = macos ]; then
  HOST_ARCH=$(uname -m)
  if [ "$ARCH" = x64 ]; then
    test "$HOST_ARCH" = x86_64
    MACH_ARCH=x86_64
    DMG="dist/TokenPulse-${VERSION}.dmg"
  else
    test "$HOST_ARCH" = arm64
    MACH_ARCH=arm64
    DMG="dist/TokenPulse-${VERSION}-arm64.dmg"
  fi
  printf 'host=%s expected=%s\n' "$HOST_ARCH" "$MACH_ARCH" > "$WORK/architecture.txt"
  hdiutil verify "$DMG" > "$WORK/dmg-verify.log" 2>&1
  MOUNT="$WORK/mount"
  mkdir -p "$MOUNT"
  hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT" > "$WORK/dmg-mount.log" 2>&1
  BUNDLE="$WORK/app/TokenPulse.app"
  mkdir -p "$WORK/app"
  ditto "$MOUNT/TokenPulse.app" "$BUNDLE"
  BIN="$BUNDLE/Contents/MacOS/TokenPulse"
  cmp "$MOUNT/TokenPulse.app/Contents/MacOS/TokenPulse" "$BIN"
  cmp "$MOUNT/TokenPulse.app/Contents/Resources/app.asar" "$BUNDLE/Contents/Resources/app.asar"
  lipo -archs "$BIN" >> "$WORK/architecture.txt"
  lipo -verify_arch "$MACH_ARCH" "$BIN"
  plutil -lint "$BUNDLE/Contents/Info.plist" > "$WORK/plist.log"
  codesign -dv "$BUNDLE" > "$WORK/signature.log" 2>&1 || true
  DB="$HOME/Library/Application Support/TokenPulse/agentmeter.db"
  if pgrep -x TokenPulse >/dev/null; then
    printf 'Unexpected existing TokenPulse instance\n' >&2
    exit 1
  fi
  if ! open -n --env "TOKENPULSE_SMOKE_DIR=$SMOKE" --stdout "$LOG" --stderr "$WORK/app-error.log" "$BUNDLE" > "$WORK/open.log" 2>&1; then
    printf 'LaunchServices could not start the packaged application\n' >&2
    exit 1
  fi
elif [ "$PLATFORM" = windows ]; then
  BIN="$PWD/dist/win-unpacked/TokenPulse.exe"
  DB="$APPDATA/TokenPulse/agentmeter.db"
  export TOKENPULSE_SMOKE_DIR
  TOKENPULSE_SMOKE_DIR=$(cygpath -w "$SMOKE")
  "$BIN" > "$LOG" 2>&1 &
  APP_PID=$!
else
  BIN="$PWD/dist/linux-unpacked/tokenpulse"
  test -x "$BIN"
  DB="${XDG_CONFIG_HOME:-$HOME/.config}/TokenPulse/agentmeter.db"
  # This uninstalled CI bundle cannot use its setuid helper; normal runtime defaults are unchanged.
  setsid xvfb-run -a "$BIN" --no-sandbox > "$LOG" 2>&1 &
  APP_PID=$!
fi

ok=0
for ((i=0; i<60; i++)); do
  if [ -s "$SMOKE/ready" ] && [ -s "$SMOKE/boot" ] && [ -s "$SMOKE/window-ready" ] && [ -s "$SMOKE/tray-ready" ] && [ -s "$DB" ]; then
    ok=1
    break
  fi
  if [ -n "$APP_PID" ] && ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
  sleep 1
done

ls -l "$SMOKE" > "$WORK/markers.txt"
if [ "$PLATFORM" = macos ]; then
  pgrep -fl "$BUNDLE/Contents/MacOS/TokenPulse" > "$WORK/processes.txt" || true
  if [ "$ok" != 1 ]; then
    pid=$(pgrep -f "$BUNDLE/Contents/MacOS/TokenPulse$" | head -n 1 || true)
    if [ -n "$pid" ]; then sample "$pid" 3 -file "$WORK/process-sample.txt" >/dev/null 2>&1 || true; fi
    log show --style compact --last 2m --predicate 'process == "TokenPulse"' > "$WORK/system.log" 2>&1 || true
  fi
fi
if [ "$ok" != 1 ]; then
  printf '::error::Packaged application did not complete ready/boot/window/tray/database checks within 60s\n' >&2
  exit 1
fi
printf 'Runtime smoke passed: %s %s\n' "$PLATFORM" "$ARCH"

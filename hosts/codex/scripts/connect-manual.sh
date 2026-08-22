#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manager="$script_dir/managed-config.mjs"

if [ "${1:-}" = "--oauth" ]; then
  if [ "$#" -ne 1 ]; then
    printf '%s\n' 'Usage: connect-manual.sh [--oauth]' >&2
    exit 1
  fi
  exec node "$manager" codex oauth
fi

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: connect-manual.sh [--oauth]' >&2
  exit 1
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  printf '%s\n' 'Run this command from a private interactive terminal.' >&2
  exit 1
fi

restore_terminal() {
  stty echo </dev/tty 2>/dev/null || true
  unset token
}

trap restore_terminal EXIT HUP INT TERM
printf '%s' 'Parley manual token: ' >/dev/tty
stty -echo </dev/tty
IFS= read -r token </dev/tty
printf '\n' >/dev/tty
stty echo </dev/tty

{
  printf '%s\n' "$token"
  token=""
} | node "$manager" codex manual

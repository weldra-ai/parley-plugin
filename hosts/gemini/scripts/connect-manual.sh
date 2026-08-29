#!/usr/bin/env sh
set -eu

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: connect-manual.sh' >&2
  exit 1
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  printf '%s\n' 'Run this command from a private interactive terminal.' >&2
  exit 1
fi

exec gemini extensions config parley PARLEY_TOKEN --scope user

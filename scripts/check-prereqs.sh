#!/usr/bin/env bash
set -e

missing=0

check() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "OK   $1 - $(command -v "$1")"
  else
    echo "FAIL $1 - not found (required)"
    missing=1
  fi
}

check bun
check uv

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "Missing required tools. Install them before continuing."
  exit 1
fi

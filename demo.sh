#!/usr/bin/env bash
# Scripted demo for asciinema recording
# Shows: index stats → find-symbol → context → find-refs

# type a command char by char, then run it
run() {
  local cmd="$1"
  local pause="${2:-1.2}"
  printf '\033[1;32m$\033[0m '
  for ((i = 0; i < ${#cmd}; i++)); do
    printf '%s' "${cmd:$i:1}"
    sleep 0.04
  done
  printf '\n'
  sleep 0.2
  eval "$cmd"
  sleep "$pause"
}

stty cols 120 rows 32 2>/dev/null || true
clear
sleep 0.8

# Run from a directory that has the pre-built zod index as the default DB name
DEMO_DIR="$(mktemp -d)"
cp /home/ubuntu/zod.db "$DEMO_DIR/code-indexer.db"
cd "$DEMO_DIR"

# ── step 1: see what's in the index ─────────────────────────────────────────
run "code-indexer stats" 1.5

# ── step 2: where is safeParse defined? ─────────────────────────────────────
run "code-indexer find-symbol safeParse" 1.5

# ── step 3: read just that implementation — not the whole file ───────────────
run "code-indexer context safeParse" 2.0

# ── step 4: who depends on it? ───────────────────────────────────────────────
run "code-indexer find-refs safeParse | cut -f1 | sort -u | wc -l" 2.0

rm -rf "$DEMO_DIR"

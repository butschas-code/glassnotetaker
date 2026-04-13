#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN=""
for cand in \
  "$ROOT/native/GlassCallAudioCapture/.build/arm64-apple-macosx/release/GlassCallAudioCapture" \
  "$ROOT/native/GlassCallAudioCapture/.build/release/GlassCallAudioCapture"
do
  if [[ -f "$cand" ]]; then BIN="$cand"; break; fi
done
if [[ -z "$BIN" ]]; then
  echo "Build the Swift helper first: npm run native:audio" >&2
  exit 1
fi
DEST="$ROOT/resources"
mkdir -p "$DEST"
cp -f "$BIN" "$DEST/GlassCallAudioCapture"
echo "Copied to $DEST/GlassCallAudioCapture"

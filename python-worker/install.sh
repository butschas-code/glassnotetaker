#!/usr/bin/env bash
# WhisperX + PyTorch for GlassCall Notes. Creates python-worker/.venv
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PY="${PYTHON:-python3}"
if ! command -v "$PY" &>/dev/null; then
  echo "Need python3 on PATH (or set PYTHON=/path/to/python3.12)." >&2
  exit 1
fi

VER="$($PY -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
echo "Using: $($PY --version) (parsed: $VER)"

MAJOR="$($PY -c 'import sys; print(sys.version_info.major)')"
MINOR="$($PY -c 'import sys; print(sys.version_info.minor)')"

if [ "$MAJOR" -ne 3 ] || [ "$MINOR" -lt 10 ]; then
  echo "Need Python 3.10 or newer." >&2
  exit 1
fi

if [ "$MINOR" -ge 14 ]; then
  echo "Python 3.14 is not supported by WhisperX/ctranslate2 pins yet." >&2
  echo "Install Python 3.12 (recommended) or 3.11:" >&2
  echo "  brew install python@3.12" >&2
  echo "  PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12 npm run python:install" >&2
  exit 1
fi

rm -rf .venv
"$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate

python -m pip install --upgrade pip setuptools wheel

# WhisperX pulls a compatible torch/torchaudio/torchvision set (e.g. torch~=2.8 for whisperx 3.8.x).
python -m pip install -r requirements.txt

echo ""
echo "OK. Activate: source python-worker/.venv/bin/activate"

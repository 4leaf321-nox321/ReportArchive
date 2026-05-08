#!/usr/bin/env bash
# Cross-platform venv bootstrap (Linux / macOS side).
# Run this once after cloning. Windows users: setup_venv.bat
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d venv ]; then
    python3 -m venv venv
fi

# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt

if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example - please review it."
fi

cat <<'EOF'

Backend venv ready. Activate with:  source venv/bin/activate
Run with:  python run.py
EOF

@echo off
REM Cross-platform venv bootstrap (Windows side).
REM Run this once after cloning. Linux/Mac users: see setup_venv.sh

setlocal
cd /d %~dp0

if not exist venv (
    python -m venv venv
)

call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

if not exist .env (
    copy .env.example .env
    echo Created .env from .env.example - please review it.
)

echo.
echo Backend venv ready. Activate with:  venv\Scripts\activate
echo Run with:  python run.py
endlocal

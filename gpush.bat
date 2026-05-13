@echo off
if "%~1"=="" (
    echo Usage: gpush "commit message"
    echo.
    echo Example:
    echo   gpush "fix: log parsing bug"
    echo   gpush "feat: add report template"
    exit /b 1
)

echo --- git add . ---
git add .
if errorlevel 1 exit /b 1

echo --- git commit ---
git commit -m "%~1"
if errorlevel 1 (
    echo [abort] commit failed or nothing to commit.
    exit /b 1
)

echo --- git push ---
git push
if errorlevel 1 exit /b 1

echo [done] pushed to GitHub.

@echo off
REM Build a release bundle by invoking the Linux build script inside WSL.
REM Output lands in <repo>/release/reportarchive-<version>.tar.gz
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/projects/ReportArchive && ./deploy/build_bundle.sh"

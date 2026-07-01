@echo off
setlocal enabledelayedexpansion

set "missing=0"

for %%T in (bun uv) do (
    where %%T >nul 2>&1
    if !errorlevel! equ 0 (
        echo OK   %%T
    ) else (
        echo FAIL %%T - not found ^(required^)
        set "missing=1"
    )
)

if !missing! equ 1 (
    echo.
    echo Missing required tools. Install them before continuing.
    exit /b 1
)

exit /b 0

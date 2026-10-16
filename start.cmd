@echo off
rem ---------------------------------------------------------------------------
rem Keep this file ASCII-only, with CRLF line endings.
rem cmd.exe parses .cmd files byte-by-byte using the ANSI code page, so a
rem UTF-8 file containing non-ASCII text (especially together with "chcp 65001")
rem desyncs its parser and mangles the following lines. LF-only endings also
rem break parenthesised blocks. All Chinese output is printed by server.js.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Please install Node.js 18+ from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

set BCZ_OPEN_BROWSER=1
node server.js

echo.
pause

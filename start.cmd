@echo off
rem ---------------------------------------------------------------------------
rem Keep this file ASCII-only, with CRLF line endings.
rem cmd.exe parses .cmd files byte-by-byte using the ANSI code page, so a
rem UTF-8 file containing non-ASCII text (especially together with "chcp 65001")
rem desyncs its parser and mangles the following lines. LF-only endings also
rem break parenthesised blocks. Chinese output therefore comes either from
rem server.js or from the UTF-8 text files printed with "type" below.
rem
rem Structure note: this file deliberately uses "goto" labels instead of
rem parenthesised blocks, because a multi-line block breaks if any line
rem ending is LF instead of CRLF. Labels are immune to that.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 goto no_node

rem Node.js 18 is the floor: the server relies on the global fetch().
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 goto old_node

set BCZ_OPEN_BROWSER=1
node server.js
goto end

:no_node
type "%~dp0tools\msg-no-node.txt"
echo.
pause
exit /b 1

:old_node
type "%~dp0tools\msg-old-node.txt"
echo.
pause
exit /b 1

:end
echo.
pause

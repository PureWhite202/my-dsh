@echo off
rem Open the University of Southampton Blackboard with the persistent Chromium
rem profile that keeps the SSO login. CDP on 9222 lets Playwright attach.
rem Handy to double-click when you need to re-login manually.
setlocal
set "EXE=C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1247\chrome-win64\chrome.exe"
set "PROFILE=C:\Users\Administrator\.dsh\browser-profiles\blackboard"
set "PORT=9222"
set "URL=https://blackboard.soton.ac.uk/ultra/course"

if not exist "%EXE%" (
  echo [ERROR] Chromium not found: %EXE%
  pause
  exit /b 2
)
if not exist "%PROFILE%" (
  echo [WARN] Profile not found, a fresh login will be needed: %PROFILE%
)

start "" "%EXE%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --remote-debugging-port=%PORT% --no-sandbox --disable-gpu "%URL%"
echo Launched Chromium on CDP port %PORT%.
echo If Blackboard asks to sign in or to enter a code, finish it in the window,
echo then tell the assistant, so it can continue.

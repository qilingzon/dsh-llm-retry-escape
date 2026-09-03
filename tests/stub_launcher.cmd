@echo off
rem stub_launcher.cmd - relay E2E test: forward the relay's fixed five args to the stub agent
rem call shape: stub_launcher.cmd --expose-internals <stub.ps1> --profile ^<prof^> ^<task^>
powershell -NoProfile -ExecutionPolicy Bypass -File "%~2" %~5
exit /b %ERRORLEVEL%
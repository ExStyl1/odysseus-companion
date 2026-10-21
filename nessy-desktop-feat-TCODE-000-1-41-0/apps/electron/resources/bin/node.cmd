@echo off
if "%NESSY_BUN%"=="" (
  echo nessy-managed-node-runtime-unavailable 1>&2
  exit /b 127
)
if not exist "%NESSY_BUN%" (
  echo nessy-managed-node-runtime-unavailable 1>&2
  exit /b 127
)
"%NESSY_BUN%" %*
exit /b %errorlevel%

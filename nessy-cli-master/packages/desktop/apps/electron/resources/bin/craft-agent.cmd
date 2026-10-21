@echo off
set "CRAFT_BUN_BIN=%CRAFT_BUN%"
if "%CRAFT_BUN_BIN%"=="" (
  echo Bundled Bun runtime is unavailable: CRAFT_BUN is not set 1>&2
  exit /b 1
)
set "CRAFT_COMMANDS_BIN=%CRAFT_COMMANDS_ENTRY%"
if "%CRAFT_COMMANDS_BIN%"=="" set "CRAFT_COMMANDS_BIN=%CRAFT_CLI_ENTRY%"
if "%CRAFT_CLI_JSON_ONLY%"=="" set "CRAFT_CLI_JSON_ONLY=1"
"%CRAFT_BUN_BIN%" run "%CRAFT_COMMANDS_BIN%" %*

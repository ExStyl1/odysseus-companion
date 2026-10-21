import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const scriptPath = path.resolve(
  'scripts/diagnostics/collect-windows-diagnostics.ps1',
);
const script = readFileSync(scriptPath, 'utf8');

describe('Windows diagnostics script', () => {
  it('diagnoses every packaged Desktop Nessy CLI bundle', () => {
    expect(script).toContain("'resources\\app'");
    expect(script).toContain("'vendor\\nessy-cli\\cli.js'");
    expect(script).toContain("'vendor\\bun\\win32-x64\\bun.exe'");
    expect(script).toContain("@('--version')");
    expect(script).toContain("@('extensions', 'list', '--json')");
    expect(script).toContain("@('mcp', 'reconnect', '--all')");
    expect(script).toContain('MCP STARTUP DEBUG');
    expect(script).toContain("@('mcp', 'list')");
    expect(script).toContain("NESSY_DEBUG_LOG_FILE = '1'");
    expect(script).toContain("@($Runtime.CliPath, '--debug') + $Arguments");
    expect(script).toContain("Mode = 'bundled Bun missing'");
    expect(script).toContain("@('node', 'bun')");
    expect(script).toContain('function Resolve-CommandPath');
    expect(script).toContain('Bundled CLI diagnostics are unaffected.');
    expect(script).not.toContain("Mode = 'Electron as Node'");
    expect(script).toContain('foreach ($installPath in $installations)');
    expect(script).toContain(
      'foreach ($temporaryPath in @($stdoutPath, $stderrPath))',
    );
    expect(script).toContain('[IO.File]::Delete($temporaryPath)');
    expect(script).not.toMatch(/Remove-Item -LiteralPath \$temporaryPath/);
    expect(script).not.toContain(
      'Remove-Item -LiteralPath $stdoutPath, $stderrPath',
    );
  });

  it('collects dp information, full config, and recent bounded logs', () => {
    expect(script).toContain("Join-Path $nessyHome 'dp_latest'");
    expect(script).toContain("Join-Path $dpWorkDir 'dp.exe'");
    expect(script).toContain('DP INSTALLATION CHECK');
    expect(script).toContain('$dpInstalled = Test-Path');
    expect(script).toContain('if ($dpInstalled)');
    expect(script).toContain('Skipped because managed dp is not installed.');
    expect(script).toContain('DP_WORKDIR = $dpWorkDir');
    expect(script).toContain("@('plugin', 'list')");
    expect(script).not.toContain("Resolve-CommandPath 'dp'");
    expect(script).toContain("'.nessy\\settings.json'");
    expect(script).toContain("'.mcp.json'");
    expect(script).toContain('AddHours(-24)');
    expect(script).toContain('$script:MaxLogFileBytes = 5MB');
    expect(script).toContain('$script:MaxTotalLogBytes = 25MB');
    expect(script).toContain('TRUNCATED: only the tail');
    expect(script).toContain('Get-DebugLogSnapshot $debugDirectory');
    expect(script).toContain(
      'Get-ChangedDebugLogs $debugDirectory $debugSnapshot',
    );
    expect(script).toContain('CURRENT RUN DEBUG LOGS');
    expect(script).toContain("Join-Path (Get-NessyHome) 'debug'");
  });

  it('produces one local sensitive report without uploading it', () => {
    expect(script).toContain('nessy-diagnostics-');
    expect(script).toContain('$baseDirectory = (Get-Location).Path');
    expect(script).not.toContain('$baseDirectory = $PSScriptRoot');
    expect(script).toContain('THIS REPORT MAY CONTAIN TOKENS');
    expect(script).not.toContain(
      "Write-Warning 'The resulting report contains full configuration",
    );
    expect(script).toContain('[IO.File]::WriteAllText($Destination');
    expect(script).not.toMatch(
      /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|curl\.exe/i,
    );
    expect(script).not.toMatch(/Compress-Archive|\.zip/i);
  });

  const itOnWindows = process.platform === 'win32' ? it : it.skip;

  itOnWindows('loads in library mode with Windows PowerShell', () => {
    const command =
      `. '${scriptPath.replaceAll("'", "''")}' -LibraryMode; ` +
      'Remove-AnsiEscapeSequences "`e[31mDisconnected`e[0m"';
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Disconnected');
    expect(result.stderr).toBe('');
  });
});

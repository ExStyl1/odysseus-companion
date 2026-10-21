#Requires -Version 5.1

[CmdletBinding()]
param([string]$OutputPath, [switch]$LibraryMode)

$ErrorActionPreference = 'Stop'
$script:ReportEncoding = [Text.UTF8Encoding]::new($false)
$script:LogCutoff = (Get-Date).AddHours(-24)
$script:MaxLogFileBytes = 5MB
$script:MaxTotalLogBytes = 25MB
$script:TotalLogBytes = 0L

function Remove-AnsiEscapeSequences {
    param([AllowEmptyString()][string]$Text)
    if ($null -eq $Text) { return '' }
    return [regex]::Replace($Text, "`e\[[0-?]*[ -/]*[@-~]", '')
}

function Add-ReportSection {
    param([Parameter(Mandatory)][Text.StringBuilder]$Report, [Parameter(Mandatory)][string]$Title, [AllowEmptyString()][string]$Content)
    [void]$Report.AppendLine()
    [void]$Report.AppendLine(('=' * 80))
    [void]$Report.AppendLine($Title)
    [void]$Report.AppendLine(('=' * 80))
    [void]$Report.AppendLine((Remove-AnsiEscapeSequences $Content).TrimEnd())
}

function ConvertTo-ProcessArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Argument)
    if ($Argument -notmatch '[\s"]') { return $Argument }
    return '"' + $Argument.Replace('"', '\"') + '"'
}

function Invoke-DiagnosticCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [hashtable]$Environment = @{},
        [int]$TimeoutSeconds = 30,
        [string]$WorkingDirectory = (Get-Location).Path
    )
    $stdoutPath = Join-Path $env:TEMP ('.nessy-diag-stdout-' + [guid]::NewGuid().ToString('N') + '.txt')
    $stderrPath = Join-Path $env:TEMP ('.nessy-diag-stderr-' + [guid]::NewGuid().ToString('N') + '.txt')
    $startedAt = Get-Date
    $oldEnvironment = @{}
    try {
        foreach ($name in $Environment.Keys) {
            $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, [string]$Environment[$name], 'Process')
        }
        $processArguments = @($Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ })
        $process = Start-Process -FilePath $FilePath -ArgumentList $processArguments -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $completed = $process.WaitForExit($TimeoutSeconds * 1000)
        if (-not $completed) {
            try { $process.Kill() } catch {}
            try { $process.WaitForExit() } catch {}
        }
        $stdout = if (Test-Path -LiteralPath $stdoutPath) { [IO.File]::ReadAllText($stdoutPath) } else { '' }
        $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { '' }
        return [pscustomobject]@{
            Command = "$FilePath $($Arguments -join ' ')".Trim()
            ExitCode = if ($completed) { $process.ExitCode } else { $null }
            TimedOut = -not $completed
            DurationMs = [math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
            Stdout = $stdout
            Stderr = $stderr
        }
    } catch {
        return [pscustomobject]@{ Command = "$FilePath $($Arguments -join ' ')".Trim(); ExitCode = $null; TimedOut = $false; DurationMs = [math]::Round(((Get-Date) - $startedAt).TotalMilliseconds); Stdout = ''; Stderr = $_.Exception.Message }
    } finally {
        foreach ($name in $Environment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
        foreach ($temporaryPath in @($stdoutPath, $stderrPath)) {
            try { [IO.File]::Delete($temporaryPath) } catch {}
        }
    }
}

function Format-CommandResult {
    param([Parameter(Mandatory)]$Result)
    $exitCode = if ($null -eq $Result.ExitCode) { '<not available>' } else { $Result.ExitCode }
    return @("Command: $($Result.Command)", "Exit code: $exitCode", "Timed out: $($Result.TimedOut)", "Duration: $($Result.DurationMs) ms", '--- stdout ---', $Result.Stdout, '--- stderr ---', $Result.Stderr) -join "`r`n"
}

function Get-CanonicalPath {
    param([Parameter(Mandatory)][string]$Path)
    try { return (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\') }
    catch { return [IO.Path]::GetFullPath($Path).TrimEnd('\') }
}

function Get-DesktopInstallations {
    $candidates = [Collections.Generic.List[string]]::new()
    foreach ($registryPath in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        Get-ItemProperty $registryPath -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Nessy CLI Desktop*' } | ForEach-Object {
            if ($_.InstallLocation) { [void]$candidates.Add($_.InstallLocation) }
            if ($_.DisplayIcon) {
                $iconPath = ([string]$_.DisplayIcon).Trim('"') -replace ',\d+$', ''
                if ($iconPath) { [void]$candidates.Add((Split-Path -Parent $iconPath)) }
            }
        }
    }
    foreach ($basePath in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $basePath) { continue }
        foreach ($relativePath in @('Programs\Nessy CLI Desktop', 'Nessy CLI Desktop')) {
            $candidate = Join-Path $basePath $relativePath
            if (Test-Path -LiteralPath $candidate -PathType Container) { [void]$candidates.Add($candidate) }
        }
    }
    $seen = @{}
    foreach ($candidate in $candidates) {
        try {
            $canonicalPath = Get-CanonicalPath $candidate
            $key = $canonicalPath.ToLowerInvariant()
            if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $canonicalPath }
        } catch {}
    }
}

function Get-FileDiagnosticInfo {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "Missing: $Path" }
    $item = Get-Item -LiteralPath $Path
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return @("Path: $($item.FullName)", "Size: $($item.Length) bytes", "Last modified: $($item.LastWriteTime.ToString('o'))", "File version: $($item.VersionInfo.FileVersion)", "Product version: $($item.VersionInfo.ProductVersion)", "SHA-256: $($hash.Hash)") -join "`r`n"
}

function Get-DesktopExecutable {
    param([Parameter(Mandatory)][string]$InstallPath)
    $preferred = Join-Path $InstallPath 'Nessy CLI Desktop.exe'
    if (Test-Path -LiteralPath $preferred -PathType Leaf) { return $preferred }
    return Get-ChildItem -LiteralPath $InstallPath -Filter '*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'unins|update|squirrel' } | Select-Object -First 1 -ExpandProperty FullName
}

function Get-NessyRuntime {
    param([Parameter(Mandatory)][string]$InstallPath)
    $resourcesApp = Join-Path $InstallPath 'resources\app'
    $cliPath = Join-Path $resourcesApp 'vendor\nessy-cli\cli.js'
    $bunPath = Join-Path $resourcesApp 'vendor\bun\win32-x64\bun.exe'
    if (Test-Path -LiteralPath $bunPath -PathType Leaf) { return [pscustomobject]@{ FilePath = $bunPath; CliPath = $cliPath; Mode = 'bundled Bun' } }
    return [pscustomobject]@{ FilePath = $null; CliPath = $cliPath; Mode = 'bundled Bun missing' }
}

function Invoke-BundledCli {
    param([Parameter(Mandatory)]$Runtime, [Parameter(Mandatory)][string[]]$Arguments, [int]$TimeoutSeconds = 60)
    if (-not $Runtime.FilePath -or -not (Test-Path -LiteralPath $Runtime.CliPath -PathType Leaf)) {
        return [pscustomobject]@{ Command = $Runtime.CliPath; ExitCode = $null; TimedOut = $false; DurationMs = 0; Stdout = ''; Stderr = 'Bundled Nessy CLI or its runtime was not found.' }
    }
    $environment = @{ NESSY_DEBUG_LOG_FILE = '1'; NO_COLOR = '1' }
    return Invoke-DiagnosticCommand -FilePath $Runtime.FilePath -Arguments (@($Runtime.CliPath, '--debug') + $Arguments) -Environment $environment -TimeoutSeconds $TimeoutSeconds
}

function Get-NessyHome {
    if ($env:NESSY_HOME) {
        return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:NESSY_HOME))
    }
    return Join-Path $env:USERPROFILE '.nessy'
}

function Get-DebugLogSnapshot {
    param([Parameter(Mandatory)][string]$DebugDirectory)
    $snapshot = @{}
    if (-not (Test-Path -LiteralPath $DebugDirectory -PathType Container)) { return $snapshot }
    foreach ($file in Get-ChildItem -LiteralPath $DebugDirectory -File -ErrorAction SilentlyContinue) {
        $snapshot[$file.FullName.ToLowerInvariant()] = "$($file.LastWriteTimeUtc.Ticks):$($file.Length)"
    }
    return $snapshot
}

function Get-ChangedDebugLogs {
    param([Parameter(Mandatory)][string]$DebugDirectory, [Parameter(Mandatory)][hashtable]$Before)
    if (-not (Test-Path -LiteralPath $DebugDirectory -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $DebugDirectory -File -ErrorAction SilentlyContinue | Where-Object {
        $key = $_.FullName.ToLowerInvariant()
        $state = "$($_.LastWriteTimeUtc.Ticks):$($_.Length)"
        -not $Before.ContainsKey($key) -or $Before[$key] -ne $state
    })
}

function Get-ConfigFiles {
    $paths = [Collections.Generic.List[string]]::new()
    if ($env:USERPROFILE) { [void]$paths.Add((Join-Path $env:USERPROFILE '.nessy\settings.json')) }
    foreach ($name in @('.nessy\settings.json', '.mcp.json')) { [void]$paths.Add((Join-Path (Get-Location).Path $name)) }
    return $paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique
}

function Add-FileContentToReport {
    param([Parameter(Mandatory)][Text.StringBuilder]$Report, [Parameter(Mandatory)][string]$Path, [long]$MaxBytes = $script:MaxLogFileBytes)
    try {
        $item = Get-Item -LiteralPath $Path
        $remainingBytes = $script:MaxTotalLogBytes - $script:TotalLogBytes
        if ($remainingBytes -le 0) { Add-ReportSection $Report "LOG SKIPPED: $Path" 'Total log size limit reached.'; return }
        $bytesToRead = [math]::Min([math]::Min($item.Length, $MaxBytes), $remainingBytes)
        $stream = [IO.File]::Open($item.FullName, 'Open', 'Read', 'ReadWrite')
        try {
            if ($item.Length -gt $bytesToRead) { [void]$stream.Seek(-$bytesToRead, 'End') }
            $buffer = New-Object byte[] ([int]$bytesToRead)
            $read = $stream.Read($buffer, 0, $buffer.Length)
        } finally { $stream.Dispose() }
        $script:TotalLogBytes += $read
        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        $metadata = "Path: $($item.FullName)`r`nLast modified: $($item.LastWriteTime.ToString('o'))`r`nOriginal size: $($item.Length) bytes`r`nIncluded: $read bytes"
        if ($item.Length -gt $read) { $metadata += "`r`nTRUNCATED: only the tail of this file is included." }
        Add-ReportSection $Report "LOG: $($item.Name)" "$metadata`r`n--- content ---`r`n$text"
    } catch { Add-ReportSection $Report "LOG ERROR: $Path" "ERROR: $($_.Exception.Message)" }
}

function Get-RecentLogFiles {
    $directories = [Collections.Generic.List[string]]::new()
    if ($env:USERPROFILE) {
        [void]$directories.Add((Join-Path (Get-NessyHome) 'debug'))
        [void]$directories.Add((Join-Path $env:USERPROFILE '.craft-agent\logs'))
    }
    if ($env:APPDATA) {
        foreach ($name in @('Nessy CLI Desktop\logs', 'nessy-cli\logs', 'ru.tbank.nessy-cli\logs')) { [void]$directories.Add((Join-Path $env:APPDATA $name)) }
    }
    foreach ($directory in $directories | Select-Object -Unique) {
        if (Test-Path -LiteralPath $directory -PathType Container) {
            Get-ChildItem -LiteralPath $directory -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $script:LogCutoff -and $_.Extension -in @('.log', '.txt', '.json', '.jsonl') }
        }
    }
}

function Resolve-CommandPath {
    param([Parameter(Mandatory)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Get-SystemSummary {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    return @("Generated: $((Get-Date).ToString('o'))", "Computer: $env:COMPUTERNAME", "User: $env:USERNAME", "OS: $($os.Caption) $($os.Version) build $($os.BuildNumber)", "Architecture: $env:PROCESSOR_ARCHITECTURE", "PowerShell: $($PSVersionTable.PSVersion)", "Current directory: $((Get-Location).Path)", "PATH: $env:PATH", "HTTP_PROXY: $env:HTTP_PROXY", "HTTPS_PROXY: $env:HTTPS_PROXY", "NO_PROXY: $env:NO_PROXY") -join "`r`n"
}

function Invoke-NessyWindowsDiagnostics {
    param([string]$Destination)
    $report = [Text.StringBuilder]::new()
    [void]$report.AppendLine('NESSY CLI DESKTOP WINDOWS DIAGNOSTICS')
    [void]$report.AppendLine('WARNING: THIS REPORT MAY CONTAIN TOKENS, PASSWORDS, PRIVATE URLS,')
    [void]$report.AppendLine('ENVIRONMENT VALUES, USER PATHS, AND OTHER SECRETS.')
    [void]$report.AppendLine('SHARE IT ONLY WITH TRUSTED SUPPORT PERSONNEL.')
    Add-ReportSection $report 'SYSTEM' (Get-SystemSummary)
    $debugDirectory = Join-Path (Get-NessyHome) 'debug'
    $debugSnapshot = Get-DebugLogSnapshot $debugDirectory
    $processes = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'nessy|craft' } | Select-Object ProcessName, Id, Path, StartTime | Format-Table -AutoSize | Out-String
    Add-ReportSection $report 'RUNNING NESSY PROCESSES' $processes


    foreach ($commandName in @('node', 'bun')) {
        $commandPath = Resolve-CommandPath $commandName
        if ($commandPath) {
            Add-ReportSection $report "SYSTEM $($commandName.ToUpperInvariant())" (@(
                "Path: $commandPath"
                (Format-CommandResult (Invoke-DiagnosticCommand $commandPath @('--version') -TimeoutSeconds 10))
            ) -join "`r`n")
        } else {
            Add-ReportSection $report "SYSTEM $($commandName.ToUpperInvariant())" 'Not installed or not found in PATH. Bundled CLI diagnostics are unaffected.'
        }
    }

    $installations = @(Get-DesktopInstallations)
    if ($installations.Count -eq 0) { Add-ReportSection $report 'DESKTOP INSTALLATIONS' 'No Nessy CLI Desktop installations found.' }
    $index = 0
    foreach ($installPath in $installations) {
        $index++
        $executable = Get-DesktopExecutable $installPath
        $runtime = Get-NessyRuntime $installPath
        $desktopInfo = if ($executable) { Get-FileDiagnosticInfo $executable } else { 'Desktop executable not found.' }
        $runtimeInfo = if ($runtime.FilePath) { Get-FileDiagnosticInfo $runtime.FilePath } else { 'Runtime not found.' }
        Add-ReportSection $report "DESKTOP INSTALLATION $index" (@("Install path: $installPath", "Runtime mode: $($runtime.Mode)", $desktopInfo, '--- bundled CLI ---', (Get-FileDiagnosticInfo $runtime.CliPath), '--- bundled runtime ---', $runtimeInfo) -join "`r`n")
        Add-ReportSection $report "BUNDLED CLI $index`: VERSION" (Format-CommandResult (Invoke-BundledCli $runtime @('--version') -TimeoutSeconds 20))
        Add-ReportSection $report "BUNDLED CLI $index`: EXTENSIONS" (Format-CommandResult (Invoke-BundledCli $runtime @('extensions', 'list', '--json') -TimeoutSeconds 60))
        Add-ReportSection $report "BUNDLED CLI $index`: MCP STARTUP DEBUG" (Format-CommandResult (Invoke-BundledCli $runtime @('mcp', 'reconnect', '--all') -TimeoutSeconds 180))
        Add-ReportSection $report "BUNDLED CLI $index`: MCP CONNECTIONS" (Format-CommandResult (Invoke-BundledCli $runtime @('mcp', 'list') -TimeoutSeconds 180))
    }

    foreach ($configPath in Get-ConfigFiles) {
        try { Add-ReportSection $report "FULL CONFIG: $configPath" ([IO.File]::ReadAllText($configPath)) }
        catch { Add-ReportSection $report "CONFIG ERROR: $configPath" "ERROR: $($_.Exception.Message)" }
    }

    $nessyHome = Get-NessyHome
    $dpWorkDir = Join-Path $nessyHome 'dp_latest'
    $dpPath = Join-Path $dpWorkDir 'dp.exe'
    $dpInstalled = Test-Path -LiteralPath $dpPath -PathType Leaf
    Add-ReportSection $report 'DP INSTALLATION CHECK' (@(
        "Installed: $dpInstalled"
        "Expected directory: $dpWorkDir"
        "Expected binary: $dpPath"
    ) -join "`r`n")
    if ($dpInstalled) {
        $dpEnvironment = @{ DP_WORKDIR = $dpWorkDir }
        Add-ReportSection $report 'DP BINARY' (Get-FileDiagnosticInfo $dpPath)
        Add-ReportSection $report 'DP VERSION' (Format-CommandResult (Invoke-DiagnosticCommand $dpPath @('--version') -Environment $dpEnvironment -TimeoutSeconds 30))
        Add-ReportSection $report 'DP PLUGINS' (Format-CommandResult (Invoke-DiagnosticCommand $dpPath @('plugin', 'list') -Environment $dpEnvironment -TimeoutSeconds 60))
    } else { Add-ReportSection $report 'DP DIAGNOSTICS' 'Skipped because managed dp is not installed.' }

    $currentDebugLogs = @(Get-ChangedDebugLogs $debugDirectory $debugSnapshot | Sort-Object LastWriteTime, FullName)
    if ($currentDebugLogs.Count -eq 0) {
        Add-ReportSection $report 'CURRENT RUN DEBUG LOGS' "No new or updated debug logs found in: $debugDirectory"
    } else {
        foreach ($logFile in $currentDebugLogs) { Add-FileContentToReport $report $logFile.FullName }
    }
    $currentDebugPaths = @($currentDebugLogs | ForEach-Object { $_.FullName.ToLowerInvariant() })
    foreach ($logFile in Get-RecentLogFiles | Sort-Object LastWriteTime, FullName) {
        if ($currentDebugPaths -notcontains $logFile.FullName.ToLowerInvariant()) { Add-FileContentToReport $report $logFile.FullName }
    }
    if (-not $Destination) {
        $fileName = 'nessy-diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'
        $baseDirectory = (Get-Location).Path
        try {
            $probe = Join-Path $baseDirectory ('.write-probe-' + [guid]::NewGuid().ToString('N'))
            [IO.File]::WriteAllText($probe, '', $script:ReportEncoding)
            Remove-Item -LiteralPath $probe -Force
        } catch { $baseDirectory = $env:TEMP }
        $Destination = Join-Path $baseDirectory $fileName
    }
    $Destination = [IO.Path]::GetFullPath($Destination)
    [IO.File]::WriteAllText($Destination, $report.ToString(), $script:ReportEncoding)
    return $Destination
}

if (-not $LibraryMode) {
    if ($env:OS -ne 'Windows_NT') { throw 'This diagnostic script supports Windows only.' }
    Write-Host 'Collecting Nessy CLI Desktop diagnostics. This may take several minutes.'
    $resultPath = Invoke-NessyWindowsDiagnostics -Destination $OutputPath
    $result = Get-Item -LiteralPath $resultPath
    Write-Host "Diagnostic report: $($result.FullName)"
    Write-Host "Size: $($result.Length) bytes"
}

$missing = $false

function Check-Command($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Host "OK   $name - $($cmd.Source)"
    } else {
        Write-Host "FAIL $name - not found (required)"
        $script:missing = $true
    }
}

Check-Command "bun"
Check-Command "uv"

if ($missing) {
    Write-Host ""
    Write-Host "Missing required tools. Install them before continuing."
    exit 1
}

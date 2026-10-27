param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDirectory,

  [Parameter(Mandatory = $true)]
  [string]$NupkgPath,

  [Parameter(Mandatory = $true)]
  [string]$SetupPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedThumbprint,

  [Parameter(Mandatory = $true)]
  [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$normalizedThumbprint = ($ExpectedThumbprint -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
if ($normalizedThumbprint -notmatch "^[0-9A-F]{40}$") {
  throw "ExpectedThumbprint must be a 40-character certificate thumbprint."
}

$resolvedPackageDirectory = (Resolve-Path -LiteralPath $PackageDirectory).Path
$resolvedNupkgPath = (Resolve-Path -LiteralPath $NupkgPath).Path
$resolvedSetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$packageExecutable = Join-Path $resolvedPackageDirectory "chromecraft.exe"
if (-not (Test-Path -LiteralPath $packageExecutable -PathType Leaf)) {
  throw "Packaged application executable is missing: $packageExecutable"
}

$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  [IO.Path]::GetTempPath()
} else {
  $env:RUNNER_TEMP
}
$resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
$extractionDirectory = Join-Path $resolvedTemporaryRoot "chromecraft-signature-$([Guid]::NewGuid().ToString('N'))"
$embeddedExecutable = Join-Path $extractionDirectory "chromecraft.exe"

function Get-VerifiedSignatureRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Scope,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $actualThumbprint = if ($null -eq $signature.SignerCertificate) {
    ""
  } else {
    $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
  }
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "$Name has invalid Authenticode status: $($signature.Status)."
  }
  if ($actualThumbprint -ne $normalizedThumbprint) {
    throw "$Name was not signed by the expected certificate."
  }

  return [ordered]@{
    scope      = $Scope
    name       = $Name
    status     = $signature.Status.ToString()
    subject    = $signature.SignerCertificate.Subject
    thumbprint = $actualThumbprint
    sha256     = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

New-Item -ItemType Directory -Path $extractionDirectory | Out-Null
try {
  Add-Type -AssemblyName System.IO.Compression
  $archive = $null
  $archive = [IO.Compression.ZipFile]::OpenRead($resolvedNupkgPath)
  try {
    $matchingEntries = @(
      $archive.Entries | Where-Object {
        $_.FullName -ieq "lib/net45/chromecraft.exe"
      }
    )
    if ($matchingEntries.Count -ne 1) {
      throw "Expected exactly one lib/net45/chromecraft.exe in the full nupkg; found $($matchingEntries.Count)."
    }
    [IO.Compression.ZipFileExtensions]::ExtractToFile(
      $matchingEntries[0],
      $embeddedExecutable,
      $false
    )
  } finally {
    if ($null -ne $archive) {
      $archive.Dispose()
    }
  }

  $records = @(
    Get-VerifiedSignatureRecord -Path $resolvedSetupPath -Scope "setup" -Name ([IO.Path]::GetFileName($resolvedSetupPath))
    Get-VerifiedSignatureRecord -Path $packageExecutable -Scope "package" -Name "chromecraft.exe"
    Get-VerifiedSignatureRecord -Path $embeddedExecutable -Scope "nupkg" -Name "lib/net45/chromecraft.exe"
  )

  $packageRecord = $records | Where-Object { $_.scope -eq "package" }
  $nupkgRecord = $records | Where-Object { $_.scope -eq "nupkg" }
  if ($packageRecord.sha256 -ne $nupkgRecord.sha256) {
    throw "The signed chromecraft.exe in the full nupkg does not match the verified packaged executable."
  }

  $report = [ordered]@{
    schemaVersion              = 2
    allValid                  = $true
    expectedThumbprint         = $normalizedThumbprint
    packageFilesMatchedInNupkg = 1
    files                      = $records
  }
  $resolvedReportPath = [IO.Path]::GetFullPath($ReportPath)
  $reportDirectory = [IO.Path]::GetDirectoryName($resolvedReportPath)
  if (-not [string]::IsNullOrEmpty($reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resolvedReportPath -Encoding utf8NoBOM
} finally {
  if (Test-Path -LiteralPath $extractionDirectory) {
    $resolvedExtractionDirectory = (Resolve-Path -LiteralPath $extractionDirectory).Path
    $temporaryPrefix = $resolvedTemporaryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedExtractionDirectory.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a temporary directory outside RUNNER_TEMP."
    }
    Remove-Item -LiteralPath $resolvedExtractionDirectory -Recurse -Force
  }
}

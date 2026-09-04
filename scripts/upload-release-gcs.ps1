# LifeTour — upload installer to Google Cloud Storage
# [Manual] Set $Bucket below, and install Google Cloud SDK
#
# Prerequisites:
#   1. gcloud auth login
#   2. gcloud config set project YOUR_GCP_PROJECT_ID
#   3. Create a public-read bucket if needed:
#        gcloud storage buckets create gs://lifetour-releases --location=asia-east1 --uniform-bucket-level-access
#        gcloud storage buckets add-iam-policy-binding gs://lifetour-releases --member=allUsers --role=roles/storage.objectViewer
#   4. Keep update-config.js / package.json publish.url pointing to the same public URL
#
# Release steps:
#   1. Bump package.json "version" (e.g. 1.0.1)
#   2. npm run dist
#   3. npm run upload:gcs

param(
  # [Manual] GCS bucket name (no gs:// prefix)
  [string]$Bucket = "lifetour-releases",

  # dist folder (relative to project root)
  [string]$DistDir = "dist"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

function Resolve-Bin([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\$Name.cmd"),
    (Join-Path $env:ProgramFiles "Google\Cloud SDK\google-cloud-sdk\bin\$Name.cmd"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Cloud SDK\google-cloud-sdk\bin\$Name.cmd")
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

$gcloud = Resolve-Bin "gcloud"
$gsutil = Resolve-Bin "gsutil"
if (-not $gcloud -and -not $gsutil) {
  Write-Host ""
  Write-Host "ERROR: gcloud/gsutil not found. Install Google Cloud SDK and reopen PowerShell."
  Write-Host "  https://cloud.google.com/sdk/docs/install"
  Write-Host ""
  throw "Google Cloud SDK not found"
}

$distPath = Join-Path $root $DistDir
$yml = Join-Path $distPath "latest.yml"
if (-not (Test-Path $yml)) {
  throw "Missing $yml. Run npm run dist first (it creates latest.yml)."
}

# Read path: from latest.yml, or fall back to newest Setup exe
$setupName = $null
$q = [char]34
Get-Content -Path $yml -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*path:\s*(.+)\s*$') {
    $setupName = $Matches[1].Trim().Trim($q)
  }
}
if (-not $setupName) {
  $exe = Get-ChildItem -Path $distPath -Filter "LifeTour-Setup-*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($exe) { $setupName = $exe.Name }
}
if (-not $setupName) {
  throw "Cannot find LifeTour-Setup-*.exe under dist."
}

$setupPath = Join-Path $distPath $setupName
if (-not (Test-Path $setupPath)) {
  throw "Installer not found: $setupPath"
}

Write-Host "Uploading..."
Write-Host "  bucket : gs://$Bucket/"
Write-Host "  setup  : $setupName"
Write-Host "  meta   : latest.yml"

# Prefer gcloud storage (recommended). Fall back to gsutil.
if ($gcloud) {
  Write-Host "  tool   : gcloud storage"
  & $gcloud storage cp "$setupPath" "gs://$Bucket/$setupName"
  if ($LASTEXITCODE -ne 0) { throw "gcloud storage failed uploading exe" }
  & $gcloud storage cp "$yml" "gs://$Bucket/latest.yml"
  if ($LASTEXITCODE -ne 0) { throw "gcloud storage failed uploading latest.yml" }
} else {
  Write-Host "  tool   : gsutil"
  & $gsutil cp "$setupPath" "gs://$Bucket/$setupName"
  if ($LASTEXITCODE -ne 0) { throw "gsutil failed uploading exe" }
  & $gsutil cp "$yml" "gs://$Bucket/latest.yml"
  if ($LASTEXITCODE -ne 0) { throw "gsutil failed uploading latest.yml" }
}

# [Important] Do NOT set per-object ACL.
# Uniform bucket-level access buckets reject object ACL; public read is via bucket IAM:
#   allUsers -> roles/storage.objectViewer

$feed = "https://storage.googleapis.com/$Bucket/"
Write-Host ""
Write-Host "Done. Files uploaded."
Write-Host "  $($feed)latest.yml"
Write-Host "  $($feed)$setupName"
Write-Host ""
Write-Host "Confirm update-config.js updateFeedUrl matches:"
Write-Host "  $feed"
Write-Host ""
Write-Host "Quick check (should download YAML text):"
Write-Host "  $($feed)latest.yml"

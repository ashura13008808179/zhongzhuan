$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root "android-admin"))) { $root = $PSScriptRoot }
$android = Join-Path $root "android-admin"
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$sdkProp = $sdk -replace '\\', '\\'
Set-Content -Path (Join-Path $android "local.properties") -Value "sdk.dir=$sdkProp" -Encoding ASCII
$gradle = Get-ChildItem (Join-Path $env:USERPROFILE ".gradle\wrapper\dists") -Recurse -Filter "gradle.bat" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "gradle-8\." } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $gradle) { throw "找不到本机 Gradle 8，请先安装 Android Studio 或配置 GRADLE_HOME" }
Push-Location $android
try {
  & $gradle.FullName assembleDebug --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "gradle assembleDebug failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}
$apk = Join-Path $android "app\build\outputs\apk\debug\app-debug.apk"
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item $apk (Join-Path $dist "relay-admin-debug.apk") -Force
Write-Host "APK: $(Join-Path $dist 'relay-admin-debug.apk')"

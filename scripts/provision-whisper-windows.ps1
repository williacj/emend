# ABOUTME: Per-job CMake and target-native libclang setup for ordinary Windows app builds.
# ABOUTME: Pinned archives: CMake 4.4.5 (the first line supporting VS 2026 is 4.2) and libclang 22.1.8.
$ErrorActionPreference = 'Stop'
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_PATH -or -not $env:GITHUB_ENV) {
  throw 'Whisper provisioning requires GitHub Actions runner paths'
}
if (Test-Path Env:WHISPER_DONT_GENERATE_BINDINGS) {
  throw 'Unset WHISPER_DONT_GENERATE_BINDINGS: bundled Linux bindings are invalid on Windows'
}

$cmakeVersion = '4.4.5'
$cmakeName = "cmake-$cmakeVersion-windows-x86_64.zip"
$cmakeHash = '326c826486d46a23cf9d5a1c9ee3a567d427bdd02c4a34071937a2a675cff004'
$cmakeRoot = Join-Path $env:RUNNER_TEMP "emend-cmake-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
New-Item -ItemType Directory -Path $cmakeRoot -Force | Out-Null
$cmakeArchive = Join-Path $cmakeRoot $cmakeName
Invoke-WebRequest -Uri "https://github.com/Kitware/CMake/releases/download/v$cmakeVersion/$cmakeName" -OutFile $cmakeArchive -UseBasicParsing
$actual = (Get-FileHash -LiteralPath $cmakeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $cmakeHash) { throw "CMake archive SHA-256 mismatch: $actual" }
Expand-Archive -LiteralPath $cmakeArchive -DestinationPath $cmakeRoot -Force
$cmakeBin = Join-Path $cmakeRoot "cmake-$cmakeVersion-windows-x86_64\bin"
$cmakeExe = Join-Path $cmakeBin 'cmake.exe'
if (-not (Test-Path -LiteralPath $cmakeExe)) { throw "Verified CMake archive has no expected executable: $cmakeExe" }
$reported = & $cmakeExe --version
if ($LASTEXITCODE -ne 0 -or $reported[0] -ne "cmake version $cmakeVersion") { throw "Verified CMake executable did not report version $cmakeVersion" }
$cmakeBin | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8

$clangRoot = Join-Path $env:RUNNER_TEMP "emend-libclang-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
New-Item -ItemType Directory -Path $clangRoot -Force | Out-Null
$clangArchive = Join-Path $clangRoot 'libclang.22.1.8.zip'
$clangHash = '676b4aa346bc793af2fa05d80a9933825202ba65f71230417d5f0bb191dc3662'
Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/libclang.runtime.win-x64/22.1.8' -OutFile $clangArchive -UseBasicParsing
$actual = (Get-FileHash -LiteralPath $clangArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $clangHash) { throw "libclang archive SHA-256 mismatch: $actual" }
Expand-Archive -LiteralPath $clangArchive -DestinationPath $clangRoot -Force
$clangBin = Join-Path $clangRoot 'runtimes\win-x64\native'
$clangDll = Join-Path $clangBin 'libclang.dll'
if (-not (Test-Path -LiteralPath $clangDll)) { throw "Verified libclang archive has no expected DLL: $clangDll" }
"LIBCLANG_PATH=$clangBin" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8

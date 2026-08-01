# Gera os tres stems continuos de uma musica criada por src/content/songs.js.
# Execute da raiz do projeto (Windows + Microsoft Edge ou Google Chrome):
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass `
#     -File .\tools\generate-stems.ps1 -SongId frevo-de-aco -Stem all
#
# Os WAVs sao artefatos locais ignorados pelo Git. O manifesto so recebe uma
# entrada quando backing.wav, drums.wav e guitar.wav existem por completo.
param(
  [string]$SongId = 'frevo-de-aco',
  [ValidateSet('all', 'backing', 'drums', 'guitar')]
  [string]$Stem = 'all'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outDir = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "assets\audio\$SongId"))
$assetsRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'assets\audio'))
if (-not $outDir.StartsWith($assetsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destino de audio fora do projeto: $outDir"
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$edgeCandidates = @()
$edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue
if ($edgeCommand) { $edgeCandidates += $edgeCommand.Source }
$programRoots = @(
  [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
  [Environment]::GetFolderPath('ProgramFiles')
) | Where-Object { $_ }
foreach ($programRoot in $programRoots) {
  $edgeCandidates += Join-Path $programRoot 'Microsoft\Edge\Application\msedge.exe'
  $edgeCandidates += Join-Path $programRoot 'Google\Chrome\Application\chrome.exe'
}
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge/Chrome nao encontrado.' }

$list = if ($Stem -eq 'all') { @('backing', 'drums', 'guitar') } else { @($Stem) }
$pagePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'generate-stems.html'))
$pageUrl = ([System.Uri]$pagePath).AbsoluteUri

foreach ($name in $list) {
  $target = Join-Path $outDir "$name.wav"
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }

  $profile = Join-Path ([System.IO.Path]::GetTempPath()) ("gh-stem-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  try {
    Write-Host "Gerando $SongId / $name..."
    $downloadName = "gh-$SongId-$name-$([guid]::NewGuid().ToString('N')).wav"
    $url = "$pageUrl`?song=$([uri]::EscapeDataString($SongId))&stem=$name&file=$downloadName"
    $stdout = Join-Path $profile 'stdout.txt'
    $stderr = Join-Path $profile 'stderr.txt'
    # msedge.exe e um aplicativo GUI no Windows. O operador & do PowerShell
    # volta imediatamente e apagava o perfil enquanto o render ainda iniciava.
    # Start-Process -Wait mantem o processo e o download vivos ate STEM_OK.
    $args = @(
      '--headless=new', '--disable-gpu', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--allow-file-access-from-files',
      '--disable-web-security', '--no-first-run', '--no-default-browser-check', '--mute-audio',
      "--user-data-dir=`"$profile`"", "--download-default-directory=`"$outDir`"",
      '--dump-dom', "`"$url`""
    )
    $proc = Start-Process -FilePath $edge -ArgumentList $args -Wait -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $joined = if (Test-Path -LiteralPath $stdout) { [System.IO.File]::ReadAllText($stdout) } else { '' }
    if ($proc.ExitCode -ne 0 -or $joined -notmatch 'STEM_OK') {
      $errText = if (Test-Path -LiteralPath $stderr) { [System.IO.File]::ReadAllText($stderr) } else { '' }
      $details = ($joined + "`n" + $errText)
      throw "O gerador headless falhou em $name (exit=$($proc.ExitCode)). Saida: $($details.Substring(0, [Math]::Min(1200, $details.Length)))"
    }
    if (-not (Test-Path -LiteralPath $target)) {
      # Algumas versoes do Edge headless ignoram download-default-directory e
      # usam Downloads. O nome com GUID torna esta movimentacao inequivoca.
      $downloaded = Join-Path ([Environment]::GetFolderPath('UserProfile')) "Downloads\$downloadName"
      if (Test-Path -LiteralPath $downloaded) {
        Move-Item -LiteralPath $downloaded -Destination $target
      }
    }
    if (-not (Test-Path -LiteralPath $target)) { throw "O navegador nao gravou $target nem o download temporario $downloadName" }
    $size = (Get-Item -LiteralPath $target).Length
    if ($size -lt 100000) { throw "WAV incompleto ($size bytes): $target" }
    Write-Host ("OK: {0:N1} MB" -f ($size / 1MB))
  }
  finally {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedProfile = [System.IO.Path]::GetFullPath($profile)
    if ($resolvedProfile.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($resolvedProfile).StartsWith('gh-stem-')) {
      Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# So publica a entrada quando as tres faixas estao completas.
$required = @('backing', 'drums', 'guitar') | ForEach-Object { Join-Path $outDir "$_.wav" }
if (($required | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0) {
  $songDirs = Get-ChildItem -LiteralPath $assetsRoot -Directory | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'backing.wav')) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'drums.wav')) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'guitar.wav'))
  } | Sort-Object Name

  $rows = foreach ($dir in $songDirs) {
    $id = $dir.Name.Replace("'", "\'")
    "      '$id': { backing: 'assets/audio/$id/backing.wav', drums: 'assets/audio/$id/drums.wav', guitar: 'assets/audio/$id/guitar.wav' }"
  }
  $body = $rows -join ",`r`n"
  $manifest = @"
(function (GH) {
  'use strict';

  /* Gerado por tools/generate-stems.ps1. Sem uma entrada completa aqui,
     GH.Stems usa automaticamente o sintetizador procedural. */
  GH.GeneratedStems = {
    version: 1,
    sampleRate: 48000,
    songs: {
$body
    }
  };

})(window.GH = window.GH || {});
"@
  [System.IO.File]::WriteAllText((Join-Path $projectRoot 'src\content\generated-stems.js'), $manifest, [System.Text.UTF8Encoding]::new($false))
  Write-Host 'Manifesto atualizado: src/content/generated-stems.js'
}

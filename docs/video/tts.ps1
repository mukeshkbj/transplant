param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Voice = "Microsoft Hazel Desktop",
  [int]$Rate = -1
)

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$lines = Get-Content -Raw (Join-Path $PSScriptRoot "narration.json") | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($Voice)
$synth.Rate = $Rate
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($line in $lines) {
  $path = Join-Path $OutDir "$($line.id).wav"
  $synth.SetOutputToWaveFile($path, $format)
  $synth.Speak($line.voice)
  $synth.SetOutputToNull()
  Write-Output "$($line.id) -> $path"
}
$synth.Dispose()

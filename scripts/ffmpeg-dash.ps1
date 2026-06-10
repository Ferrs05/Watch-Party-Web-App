param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,

  [string]$OutputDirectory = "../media/dash"
)

$ErrorActionPreference = "Stop"
$resolvedInput = Resolve-Path $InputFile
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedOutput = Resolve-Path $OutputDirectory

Push-Location $resolvedOutput
try {
  ffmpeg -y -i $resolvedInput `
    -filter_complex "[0:v:0]split=3[v480][v720][v1080];[v480]scale=854:480[v480out];[v720]scale=1280:720[v720out];[v1080]scale=1920:1080[v1080out]" `
    -map "[v480out]" -map "[v720out]" -map "[v1080out]" -map 0:a:0 `
    -c:v libx264 -preset veryfast -keyint_min 48 -g 48 -sc_threshold 0 `
    -b:v:0 800k -maxrate:v:0 856k -bufsize:v:0 1200k `
    -b:v:1 1600k -maxrate:v:1 1712k -bufsize:v:1 2400k `
    -b:v:2 3000k -maxrate:v:2 3210k -bufsize:v:2 4500k `
    -c:a aac -b:a 128k -ac 2 `
    -use_template 1 -use_timeline 1 `
    -init_seg_name "init-stream`$RepresentationID`$.m4s" `
    -media_seg_name "chunk-stream`$RepresentationID`$-`$Number%05d`$.m4s" `
    -adaptation_sets "id=0,streams=0,1,2 id=1,streams=3" `
    -f dash "stream.mpd"
}
finally {
  Pop-Location
}

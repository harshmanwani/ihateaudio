#!/bin/sh
# Builds the 1080x1080 social cut from the 16:9 master: the full 16:9 picture
# scaled to 1080x608 between a branded top band (logo + wordmark) and bottom
# band (URL pill + line). Run from the project root after rendering the master.
#   sh square/make-square.sh
set -e
node square/shoot-overlay.mjs
ffmpeg -y -loglevel error \
  -i out/ihateaudio-launch-16x9.mp4 -i square/overlay.png \
  -filter_complex "color=c=0x0A110C:s=1080x1080:r=30[bg];[0:v]scale=1080:608:flags=lanczos[v];[bg][v]overlay=0:236:shortest=1[b];[b][1:v]overlay=0:0,format=yuv420p[out]" \
  -map "[out]" -map 0:a -c:v libx264 -preset slow -crf 14 -profile:v high -pix_fmt yuv420p -movflags +faststart \
  -c:a copy out/ihateaudio-launch-1x1.mp4
echo "out/ihateaudio-launch-1x1.mp4"

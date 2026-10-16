#!/bin/sh
# Turns a recorded take (frames + timestamps) into a constant 30 fps H.264 clip.
#   sh scripts/encode-take.sh takes/<take>
set -e
dir="$1"
ffmpeg -v error -y -f concat -safe 0 -i "$dir/frames.txt" -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 14 -movflags +faststart "$dir/take.mp4"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$dir/take.mp4"

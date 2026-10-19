#!/usr/bin/env bash
#
# Builds the light AAC encoder in src/lib/audio/aac/ from FFmpeg's own source.
#
# The site exports M4A, M4R and AAC through the 31 MB ffmpeg core, which needs
# WebAssembly SIMD (Safari 16.4 and later) and a CSP keyword Safari only learned
# in 16.0. This is the same AAC encoder, from the same FFmpeg release and the
# same compiler, with everything else left out and no SIMD:
#
#   aac-encoder.mjs + .wasm   for any browser that may compile WebAssembly
#   aac-encoder-js.mjs        the same code as plain JavaScript (wasm2js), for
#                             Safari 15, where the CSP blocks every wasm
#
# The outputs are committed, so a normal build never runs this. Run it again
# only to change the FFmpeg release, the compiler or bridge.c. It needs curl,
# git, make and python3, and fetches emsdk and the FFmpeg source into a
# scratch directory (default: a new temporary one).
#
#   scripts/aac-encoder/build.sh [work-dir]

set -euo pipefail

# Match the core: @ffmpeg/core 0.12.10 reports FFmpeg 5.1.4 built with emcc 3.1.40.
FFMPEG_VERSION=5.1.4
FFMPEG_SHA256=54383bb890a1cd62580e9f1eaa8081203196ed53bde9e98fb6b0004423f49063
EMSDK_VERSION=3.1.40

here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$here/../.." && pwd)/src/lib/audio/aac"
work="${1:-$(mktemp -d)}"
mkdir -p "$work" "$out"
cd "$work"

if [ ! -d emsdk ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
fi
./emsdk/emsdk install "$EMSDK_VERSION" >/dev/null
./emsdk/emsdk activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
source ./emsdk/emsdk_env.sh >/dev/null 2>&1

if [ ! -d "ffmpeg-$FFMPEG_VERSION" ]; then
  curl -sSfL -o "ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
  echo "$FFMPEG_SHA256  ffmpeg-$FFMPEG_VERSION.tar.xz" | shasum -a 256 -c -
  tar xJf "ffmpeg-$FFMPEG_VERSION.tar.xz"
fi

cd "ffmpeg-$FFMPEG_VERSION"
# The core's own configure line, minus every library and codec but the AAC
# encoder, and minus -msimd128. LGPL: nothing GPL is enabled.
emconfigure ./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-stripping --disable-programs --disable-doc \
  --disable-debug --disable-runtime-cpudetect --disable-autodetect \
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
  --extra-cflags='-O3' \
  --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-everything --enable-encoder=aac \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale \
  --disable-swresample --disable-postproc --disable-network \
  >/dev/null
emmake make -j"$(getconf _NPROCESSORS_ONLN)" >/dev/null

exports='_aac_open,_aac_frame_size,_aac_priming,_aac_config,_aac_config_size,_aac_plane,_aac_encode,_aac_flush,_aac_output,_aac_output_size,_aac_sizes,_aac_count,_aac_take,_aac_close'
common=(
  "$here/bridge.c" -I. libavcodec/libavcodec.a libavutil/libavutil.a
  -O3
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAacEncoder
  -sENVIRONMENT=worker
  -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=1MB
  -sMIN_SAFARI_VERSION=140100
  "-sEXPORTED_FUNCTIONS=$exports"
)

emcc "${common[@]}" -o "$out/aac-encoder.mjs"
# Static data inline rather than in a .mem file the worker would fetch.
emcc "${common[@]}" -sWASM=0 --memory-init-file 0 -o "$out/aac-encoder-js.mjs"

cd "$out"
ls -l aac-encoder.mjs aac-encoder.wasm aac-encoder-js.mjs

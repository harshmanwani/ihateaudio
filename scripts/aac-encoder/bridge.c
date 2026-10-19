/*
 * The AAC encoder from libavcodec, on its own, for the light M4A and M4R path.
 *
 * This is the same encoder the 31 MB ffmpeg core runs for `-c:a aac`, from
 * the same FFmpeg release, so a file from here and a file from the core are
 * the same codec at the same settings. Only the container is written
 * elsewhere, by src/lib/audio/mp4-write.ts.
 *
 * Every argument and return value is a 32-bit int or a pointer, so the
 * JavaScript side needs no BigInt and the wasm2js build runs on engines
 * without it.
 *
 * Built by scripts/aac-encoder/build.sh.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/log.h"

typedef struct {
  AVCodecContext *codec;
  AVFrame *frame;
  AVPacket *packet;
  /* Encoded bytes since the last aac_take, and the size of each packet. */
  uint8_t *out;
  int out_size;
  int out_cap;
  int *sizes;
  int count;
  int sizes_cap;
  int64_t pts;
} Encoder;

static int grow(Encoder *e, int bytes) {
  if (e->out_size + bytes > e->out_cap) {
    int cap = e->out_cap ? e->out_cap : 65536;
    while (cap < e->out_size + bytes) cap *= 2;
    uint8_t *out = realloc(e->out, cap);
    if (!out) return -1;
    e->out = out;
    e->out_cap = cap;
  }
  if (e->count + 1 > e->sizes_cap) {
    int cap = e->sizes_cap ? e->sizes_cap * 2 : 1024;
    int *sizes = realloc(e->sizes, cap * sizeof(int));
    if (!sizes) return -1;
    e->sizes = sizes;
    e->sizes_cap = cap;
  }
  return 0;
}

/* Moves every packet the encoder has ready into the output buffer. */
static int drain(Encoder *e) {
  for (;;) {
    int ret = avcodec_receive_packet(e->codec, e->packet);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) return ret;
    if (grow(e, e->packet->size) < 0) {
      av_packet_unref(e->packet);
      return AVERROR(ENOMEM);
    }
    memcpy(e->out + e->out_size, e->packet->data, e->packet->size);
    e->out_size += e->packet->size;
    e->sizes[e->count++] = e->packet->size;
    av_packet_unref(e->packet);
  }
}

EMSCRIPTEN_KEEPALIVE
Encoder *aac_open(int channels, int sample_rate, int bit_rate) {
  av_log_set_level(AV_LOG_QUIET);

  const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
  if (!codec) return NULL;

  Encoder *e = calloc(1, sizeof(Encoder));
  if (!e) return NULL;

  e->codec = avcodec_alloc_context3(codec);
  e->frame = av_frame_alloc();
  e->packet = av_packet_alloc();
  if (!e->codec || !e->frame || !e->packet) goto fail;

  e->codec->sample_fmt = AV_SAMPLE_FMT_FLTP;
  e->codec->sample_rate = sample_rate;
  e->codec->bit_rate = bit_rate;
  e->codec->time_base = (AVRational){1, sample_rate};
  /*
   * The layouts the encoder accepts, which are not all the defaults for their
   * channel counts: six channels default to 5.1 with side surrounds, and the
   * encoder only takes 5.1 with back ones. Seven channels have no layout here,
   * so the caller downmixes them.
   */
  AVChannelLayout layout;
  switch (channels) {
    case 1: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO; break;
    case 2: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO; break;
    case 3: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_SURROUND; break;
    case 4: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_4POINT0; break;
    case 5: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_5POINT0_BACK; break;
    case 6: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_5POINT1_BACK; break;
    case 8: layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_7POINT1; break;
    default: goto fail;
  }
  if (av_channel_layout_copy(&e->codec->ch_layout, &layout) < 0) goto fail;
  if (avcodec_open2(e->codec, codec, NULL) < 0) goto fail;

  e->frame->format = AV_SAMPLE_FMT_FLTP;
  e->frame->sample_rate = sample_rate;
  e->frame->nb_samples = e->codec->frame_size;
  if (av_channel_layout_copy(&e->frame->ch_layout, &e->codec->ch_layout) < 0) goto fail;
  if (av_frame_get_buffer(e->frame, 0) < 0) goto fail;
  return e;

fail:
  av_packet_free(&e->packet);
  av_frame_free(&e->frame);
  avcodec_free_context(&e->codec);
  free(e);
  return NULL;
}

EMSCRIPTEN_KEEPALIVE
int aac_frame_size(Encoder *e) { return e->codec->frame_size; }

/* Samples of priming the decoder discards: 1024 for this encoder. */
EMSCRIPTEN_KEEPALIVE
int aac_priming(Encoder *e) { return e->codec->initial_padding; }

/* The AudioSpecificConfig, for the esds box. */
EMSCRIPTEN_KEEPALIVE
uint8_t *aac_config(Encoder *e) { return e->codec->extradata; }

EMSCRIPTEN_KEEPALIVE
int aac_config_size(Encoder *e) { return e->codec->extradata_size; }

/*
 * Makes the frame safe to write and returns the plane for one channel. The
 * encoder can still hold a reference to the last frame's buffer, so writing
 * into it without asking first could change audio it has not read yet.
 */
EMSCRIPTEN_KEEPALIVE
float *aac_plane(Encoder *e, int channel) {
  if (channel == 0 && av_frame_make_writable(e->frame) < 0) return NULL;
  return (float *)e->frame->data[channel];
}

/* Encodes the `samples` frames written into the planes. Fewer than a full frame is only for the last one. */
EMSCRIPTEN_KEEPALIVE
int aac_encode(Encoder *e, int samples) {
  e->frame->nb_samples = samples;
  e->frame->pts = e->pts;
  e->pts += samples;
  int ret = avcodec_send_frame(e->codec, e->frame);
  if (ret < 0) return ret;
  return drain(e);
}

EMSCRIPTEN_KEEPALIVE
int aac_flush(Encoder *e) {
  int ret = avcodec_send_frame(e->codec, NULL);
  if (ret < 0 && ret != AVERROR_EOF) return ret;
  return drain(e);
}

EMSCRIPTEN_KEEPALIVE
uint8_t *aac_output(Encoder *e) { return e->out; }

EMSCRIPTEN_KEEPALIVE
int aac_output_size(Encoder *e) { return e->out_size; }

EMSCRIPTEN_KEEPALIVE
int *aac_sizes(Encoder *e) { return e->sizes; }

EMSCRIPTEN_KEEPALIVE
int aac_count(Encoder *e) { return e->count; }

/* Empties the output once JavaScript has copied it out. */
EMSCRIPTEN_KEEPALIVE
void aac_take(Encoder *e) {
  e->out_size = 0;
  e->count = 0;
}

EMSCRIPTEN_KEEPALIVE
void aac_close(Encoder *e) {
  if (!e) return;
  free(e->out);
  free(e->sizes);
  av_packet_free(&e->packet);
  av_frame_free(&e->frame);
  avcodec_free_context(&e->codec);
  free(e);
}

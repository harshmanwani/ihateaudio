# MCP listings: Claude and OpenAI directory forms

Field-by-field copy for the two reviewed directories. Server: `https://ihateaudio.com/mcp`,
Streamable HTTP, no authentication, version 0.3.0 (48 tools; the voice recorder is
website-only). Tested live on 13 Oct 2026 with a plain public link and no `file_id`:
`loudness_meter` and `audio_trimmer` both returned correct results.

Test file for reviewers (public, 105 KB, 15 s):
`https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg`

## Claude Connectors Directory — claude.ai/directory/manage

| Field | Value |
|---|---|
| Name (100) | iHateAudio |
| URL slug (permanent) | `ihateaudio` |
| One-liner (200) | Trim, convert, normalize, separate and transcribe audio files with 48 audio tools. |
| Categories | Media · Productivity · Utilities (pick the closest the portal offers) |
| Docs URL | https://ihateaudio.com/support |
| Privacy URL | https://ihateaudio.com/privacy |
| Terms URL | https://ihateaudio.com/terms |
| Support contact | support@ihateaudio.com |
| Icon | `assets/thumbnail/logo-512.png` |
| Authentication | None |

**Description (2,000 max):**

> iHateAudio gives Claude 48 audio tools: trim, join and split; convert between MP3,
> WAV, M4A, OGG and FLAC; extract audio from video; compress; normalize loudness to a
> LUFS target; boost volume or bass; change speed, tempo or pitch; add reverb, echo or
> an 8D pan; make iPhone and Android ringtones; measure BPM, key and loudness; draw a
> waveform image; separate vocals or stems; transcribe speech; make subtitles; and
> reduce background noise.
>
> Give Claude a public HTTPS link to an audio or video file and say what you want.
> The server downloads the file, runs the same tool page that powers ihateaudio.com in
> a headless browser on Cloudflare, and returns a download link to the result. Links
> expire after one hour; the input is deleted when the job ends and results after one
> day. Measurement tools (BPM, key, loudness) return numbers instead of a file.
>
> No account or API key is needed.

**Use cases:**

1. "Trim this recording to 0:05–0:40 and give me an MP3: <link>"
2. "Normalize this podcast episode to -16 LUFS: <link>"
3. "What is the BPM and key of this track? <link>"
4. "Remove the vocals from this song: <link>"
5. "Make SRT subtitles from this interview: <link>"

**Data handling:** files are fetched from the link the user gives, stored in Cloudflare
R2 only while the job runs, processed in Cloudflare Browser Rendering, and deleted;
results live behind unguessable links for one hour and are deleted after one day.
Cloudflare request logs (time, IP, path) are kept for a few days. Nothing is used for
training, sold or shared.

**Reviewer instructions:**

> No account needed. Use this public test file:
> https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg
> 1. `loudness_meter` with `files: [{download_url: <test file>}]` returns integrated
>    loudness about -31.2 LUFS and true peak about -16.7 dBTP.
> 2. `audio_trimmer` with `settings: {startSec: 0.5, endSec: 3}` and `outputFormat:
>    "mp3"` returns a 2.5-second MP3 link.
> 3. `bpm_detector`, `key_finder` return JSON. Every other tool returns download links.
> Jobs take 5–60 seconds; the AI separation tools can take a few minutes on long songs.
> If two jobs start within seconds, the second waits for a browser slot.

**Risks to watch in review:** the portal flags "AI media generation". The vocal
remover, acapella extractor and stem splitter are source separation, the voice
changer is a pitch effect, and the noise remover is noise reduction. The tool
descriptions say so; repeat it if a reviewer asks.

## OpenAI plugin directory — platform.openai.com/plugins

Prerequisite: a verified OpenAI organization (Settings → Organization → General).
Domain check: serve the token OpenAI gives at
`https://ihateaudio.com/.well-known/openai-apps-challenge` (plain text). Tell Claude
the token and it ships the file.

| Field | Value |
|---|---|
| displayName (30) | iHateAudio |
| shortDescription (30) | Edit and convert audio files |
| developerName (80) | Harsh Manwani |
| category | Productivity (or the closest media category listed) |
| websiteURL | https://ihateaudio.com |
| supportURL | https://ihateaudio.com/support |
| privacyPolicyURL | https://ihateaudio.com/privacy |
| termsOfServiceURL | https://ihateaudio.com/terms |
| Logo | `assets/thumbnail/logo-512.png` |
| Screenshots | `assets/gallery/02-drop-a-file.jpg`, `03-ai-studio.jpg`, `07-agents.jpg` |

No pricing words anywhere in the listing ("free" included), per OpenAI's guidelines.

**longDescription (4,000 max):** use the Claude description above, with "Claude"
replaced by "ChatGPT" and "Give Claude a public HTTPS link" replaced by "Share an audio
or video file in the chat".

**defaultPrompt (3 × 128):**

1. Trim this to the part between 0:10 and 0:45 and export an MP3.
2. Normalize this podcast episode to -16 LUFS.
3. What is the BPM and musical key of this song?

**Positive test cases (exactly 5):** attach `Example.ogg` to each.

| Prompt | tools_triggered | expected_behavior |
|---|---|---|
| Trim this from 0.5 s to 3 s and give me an MP3. | audio_trimmer | Returns one MP3 link, about 2.5 s long. |
| How loud is this file in LUFS? | loudness_meter | Returns integrated loudness about -31 LUFS and true peak about -17 dBTP. |
| Convert this to WAV. | wav_converter (or audio_converter) | Returns one WAV link. |
| Make this louder, normalized for Spotify. | audio_normalizer | Returns one file normalized to -14 LUFS. |
| Slow this down with reverb. | slowed_reverb | Returns one processed file, longer than the original. |

**Negative test cases (exactly 3):**

| Prompt | expected_behavior |
|---|---|
| Record my voice with the microphone. | No tool call; the voice recorder is website-only. Points to ihateaudio.com/voice-recorder. |
| Write me a song about summer. | No tool call; the plugin edits existing audio and does not generate music. |
| Send this file to my friend on WhatsApp. | No send happens; at most `send_audio_on_whatsapp` prepares a file under 16 MB and says it does not send anything. |

**demo_recording_url:** a screen recording of ChatGPT running two of the positive cases
with the plugin connected. This has to be recorded in your ChatGPT account (developer
mode → add the MCP server), then uploaded unlisted to YouTube.

**Release notes:** "First public release. 48 audio tools over MCP: editing,
conversion, loudness, effects, analysis, source separation and transcription."

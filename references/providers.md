# Providers, limits and configuration

Reference for the `video` skill. Read the section you need.

- [Video providers](#video-providers)
- [Fallback order](#fallback-order)
- [Audio providers](#audio-providers)
- [Size limits and the S3 relay](#size-limits-and-the-s3-relay)
- [Environment variables](#environment-variables)
- [Pro tier](#pro-tier)
- [Troubleshooting](#troubleshooting)

## Video providers

Used by `ask`, `summarize` and `find`. Choose one per call with `--provider`, or set the default with `VIDEO_MCP_DEFAULT_PROVIDER`.

| `--provider` | Model (default)                                  | Key                 | Notes                                                                                           |
| ------------ | ------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------- |
| `gemini`     | Gemini 3.8 Flash (`GEMINI_MODEL`)                | `GEMINI_API_KEY`    | Default. Free tier. Uploads the whole video (up to 2 GB) and hears the audio natively.          |
| `m3`         | MiniMax-M3                                       | `MINIMAX_API_KEY`   | Paid. Image frames only (≤100 per request), 1M context. Good for long videos.                   |
| `kimi`       | Kimi K3                                          | `MOONSHOT_API_KEY`  | Paid. Native file upload up to 100 MB. Broadest format support.                                 |
| `qwen`       | Qwen3.8 Max (`QWEN_MODEL=qwen3.8-flash` cheaper) | `DASHSCOPE_API_KEY` | Paid. About 10 MB inline limit for local files without the S3 relay.                            |
| `mimo`       | MiMo-V2.6 Flash (`MIMO_MODEL=mimo-v2.6-pro`)     | `MIMO_API_KEY`      | Paid. About 10 MB inline limit without S3.                                                      |
| `glm`        | GLM-5.3-Flash (`GLM_MODEL`)                      | `Z_AI_API_KEY`      | Paid. Last resort in the fallback chain. Strict parser: re-encode malformed clips (error 1210). |

Non-Gemini providers don't hear audio. When the video has an audio track, the package transcribes it with the audio provider and adds the transcript to the prompt (`AUDIO_ENHANCE_VIDEO_ANALYSIS=auto|true|false`).

For long videos, `summarize` sends keyframes instead of the full video (except with Gemini). The number is set by `VIDEO_MCP_MAX_FRAMES`: free tier 5–50, Pro 100 by default or `0` for uncapped.

## Fallback order

When the chosen provider has no key or fails at runtime, the next one in the chain with a key is tried:

| Default  | Chain                                  |
| -------- | -------------------------------------- |
| `gemini` | Gemini → M3 → Kimi → Qwen → MiMo → GLM |
| `m3`     | M3 → Gemini → Kimi → Qwen → MiMo → GLM |
| `kimi`   | Kimi → Gemini → M3 → Qwen → MiMo → GLM |
| `qwen`   | Qwen → Gemini → M3 → Kimi → MiMo → GLM |
| `mimo`   | MiMo → Gemini → M3 → Kimi → Qwen → GLM |
| `glm`    | GLM → Gemini → M3 → Kimi → Qwen → MiMo |

To keep content with one provider, set only that provider's key in the environment. A chain with a single key can't fall through to anything else.

## Audio providers

Used by `transcribe`, and by non-Gemini video providers to add a transcript to the prompt. Set the default with `AUDIO_MCP_DEFAULT_PROVIDER`. The fallback order is Deepgram → AssemblyAI → Groq → Gemini, starting from the default.

| `--provider` | Model (default)                                                   | Key                  | Diarize | Translate to English |
| ------------ | ----------------------------------------------------------------- | -------------------- | ------- | -------------------- |
| `deepgram`   | Nova-3 (`DEEPGRAM_MODEL`)                                         | `DEEPGRAM_API_KEY`   | yes     | no                   |
| `assemblyai` | Universal-3.5 Pro, with Universal-2 fallback (`ASSEMBLYAI_MODEL`) | `ASSEMBLYAI_API_KEY` | yes     | no                   |
| `groq`       | Whisper large-v3 (`GROQ_AUDIO_MODEL`)                             | `GROQ_API_KEY`       | no      | yes                  |
| `gemini`     | Gemini                                                            | `GEMINI_API_KEY`     | no      | yes                  |

Unsupported options are silently ignored, so `--diarize` with Groq returns no speaker labels. If speaker labels matter, pick `deepgram` or `assemblyai` explicitly. Deepgram and AssemblyAI transcribe many languages in the source language. Only Groq and Gemini translate to English.

## Size limits and the S3 relay

| Provider | Local file limit                               |
| -------- | ---------------------------------------------- |
| Gemini   | 2 GB upload                                    |
| Kimi     | 100 MB upload                                  |
| GLM      | About 12 MB inline. 200 MB as a direct URL.    |
| Qwen     | About 10 MB inline                             |
| MiMo     | About 10 MB inline                             |
| M3       | Frames only; a 100 MB image budget per request |

Above the inline limit, GLM, Qwen and MiMo first fall back to an upload-capable provider (Gemini or Kimi), and then to keyframes. With `AWS_S3_BUCKET` set, the package instead uploads the video to that bucket and gives the provider a presigned URL. Relayed objects are deleted when the command finishes, unless `AWS_S3_RELAY_CLEANUP=false`. AWS credentials come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`, or from `~/.aws`.

## Environment variables

All are read from the environment of the process running the script. Unset variables use their defaults.

| Variable                       | Default                   | Purpose                                               |
| ------------------------------ | ------------------------- | ----------------------------------------------------- |
| `VIDEO_MCP_DEFAULT_PROVIDER`   | `gemini`                  | Default video provider                                |
| `AUDIO_MCP_DEFAULT_PROVIDER`   | `deepgram`                | Default audio provider                                |
| `AUDIO_ENHANCE_VIDEO_ANALYSIS` | `auto`                    | Add a transcript to non-Gemini prompts                |
| `GEMINI_MODEL`                 | `gemini-3.8-flash`        | Or `gemini-3.6-flash`                                 |
| `GLM_MODEL`                    | `glm-5.3-flash`           | Or `glm-5v-turbo`, `glm-4.6v`, `glm-4.6v-flash`       |
| `QWEN_MODEL`                   | `qwen3.8-max`             | Or `qwen3.8-flash`                                    |
| `MIMO_MODEL`                   | `mimo-v2.6-flash`         | Or `mimo-v2.6-pro`                                    |
| `QWEN_BASE_URL`                | Singapore endpoint        | Regional routing                                      |
| `*_REQUEST_TIMEOUT_MS`         | `240000`                  | For `GLM_`, `QWEN_`, `MIMO_` and `M3_`                |
| `VIDEO_MCP_MAX_FRAMES`         | 50 free / 100 Pro         | Keyframe budget for `summarize`                       |
| `VIDEO_MCP_CACHE_TTL_MINUTES`  | `43200` (30 days)         | `0` disables the cache                                |
| `VIDEO_MCP_CACHE_MAX_ENTRIES`  | `100`                     | LRU eviction per video                                |
| `VIDEO_MCP_CACHE_MAX_MB`       | `5120`                    | Size-based eviction                                   |
| `YT_DLP_PATH`                  | auto-detect, then bundled | yt-dlp binary                                         |
| `YT_DLP_MAX_RESOLUTION`        | `720`                     | Max download height (free tier capped at 720)         |
| `YT_DLP_COOKIES_FILE`          | none                      | Netscape cookies for private or age-restricted videos |
| `YT_DLP_IMPERSONATE`           | none                      | For example `chrome`; needs yt-dlp with curl_cffi     |
| `VIDEO_MCP_LICENSE_KEY`        | none                      | Pro license                                           |
| `VIDEO_MCP_HOME`               | global npm install        | Skill only: path to a built package checkout          |

## Pro tier

With a valid `VIDEO_MCP_LICENSE_KEY`, yt-dlp downloads work beyond YouTube, resolution goes above 720p, and `summarize` defaults to 100 keyframes. Without it, the tools fall back to free-tier limits and add a notice starting with ⚡. They never fail outright. A license is valid for one year and is checked online against a device limit.

## Troubleshooting

| Symptom                                        | Likely cause and fix                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `video-context-mcp-server not found`           | `npm install -g video-context-mcp-server`, or set `VIDEO_MCP_HOME` to a built checkout                     |
| `No API key configured` / all providers failed | No keys in the environment. Run `check`; set keys as user env vars and restart VS Code completely.         |
| `ffprobe exited with code 1 … No such file`    | Wrong path. Quote paths with spaces, and use an absolute path when in doubt.                               |
| yt-dlp `Sign in to confirm` / `login required` | Set `YT_DLP_COOKIES_FILE` to a cookies export                                                              |
| `DRM` / Udemy errors                           | DRM content can't be downloaded. Ask the user for a local copy they are allowed to use.                    |
| GLM error 1210                                 | Malformed container. Re-encode (`ffmpeg -i in.mp4 -c:v libx264 -c:a aac out.mp4`) or use another provider. |
| Timeout on a long video                        | Raise the provider's `*_REQUEST_TIMEOUT_MS`, use Gemini (native upload), or work on a clip                 |
| Import error / `is not a function`             | The package's internal layout changed. Run `check` and update or pin the package.                          |

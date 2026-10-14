# video skill (watch, understand and transcribe videos)

This is an agent skill for Claude Code and other agents that load `SKILL.md` skills. It lets the agent work with video: read metadata, pull out frames it can look at, ask AI providers questions about a video, find moments, summarize, and transcribe speech (with speaker labels and SRT/VTT subtitles).

It replaces the Video Context MCP server. It runs the same code, the globally installed `video-context-mcp-server` npm package, but through one command-line script, `scripts/video.mjs`, instead of an MCP server. The package's provider fallback, caching and yt-dlp handling all still apply.

## Two ways it works

| Path                                                  | Commands                                 | What leaves your machine                                   | Needs API keys |
| ----------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- | -------------- |
| **Local**: the agent looks at the frames itself       | `info`, `frames`, `cache`                | Nothing                                                    | No             |
| **Provider**: an AI service watches or listens for it | `ask`, `summarize`, `find`, `transcribe` | The video, keyframes or audio, sent to that provider's API | Yes            |

For screen recordings, bug repros and short clips, the skill prefers the local path. The agent sees the real pixels (error text, UI state, code on screen), nothing is uploaded, and no keys are needed. The provider path is for what frames can't give: speech, motion, and long videos.

## Setup

### 1. Install the package and check Node

You need Node.js 20 or newer. Install the package globally:

```bash
npm install -g video-context-mcp-server
```

It bundles ffmpeg and ffprobe. yt-dlp (for YouTube and other platform links) is found automatically if it's installed on your system, or the bundled copy is used. To update later: `npm install -g video-context-mcp-server@latest`. To see the installed version: `npm ls -g video-context-mcp-server`.

If you work from a built checkout of the package instead, set `VIDEO_MCP_HOME` to the folder that contains `dist/`.

### 2. Get API keys (only for the provider commands)

Skip this step if you only need `info`, `frames` and `cache`. For everything else you need at least one key from each group:

**Video (`ask`, `summarize`, `find`):**

| Provider                    | Variable            | Get a key                                                                            |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| Gemini (default, free tier) | `GEMINI_API_KEY`    | <https://aistudio.google.com/app/apikey>                                             |
| MiniMax-M3                  | `MINIMAX_API_KEY`   | <https://platform.minimax.io/user-center/basic-information/interface-key>            |
| Kimi K3                     | `MOONSHOT_API_KEY`  | <https://platform.kimi.ai>                                                           |
| Qwen3.8                     | `DASHSCOPE_API_KEY` | <https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=dashboard#/api-key> |
| MiMo-V2.6                   | `MIMO_API_KEY`      | <https://platform.xiaomimimo.com/#/console/api-keys>                                 |
| GLM-5.3-Flash               | `Z_AI_API_KEY`      | <https://z.ai/manage-apikey/apikey-list>                                             |

**Audio (`transcribe`):**

| Provider                         | Variable             | Get a key                              |
| -------------------------------- | -------------------- | -------------------------------------- |
| Deepgram (default, free credits) | `DEEPGRAM_API_KEY`   | <https://console.deepgram.com/>        |
| AssemblyAI (free credits)        | `ASSEMBLYAI_API_KEY` | <https://www.assemblyai.com/dashboard> |
| Groq / Whisper (free tier)       | `GROQ_API_KEY`       | <https://console.groq.com/>            |
| Gemini (reuses the video key)    | `GEMINI_API_KEY`     |                                        |

A good minimal setup is a Gemini key plus a Groq key, both with free tiers. Speaker labels need Deepgram or AssemblyAI. English translation of non-English speech needs Groq or Gemini.

### 3. Put the keys in your user environment, outside any chat

The script reads keys from the environment of the process that runs it. Don't paste a key into a chat, a command or a file in a repository.

**Windows (recommended: the settings dialog, so the key never lands in a command history):**

1. Press the Windows key, type `environment variables`, and choose **Edit environment variables for your account**.
2. Under **User variables for <you>**, click **New…**, enter the variable name and value, and click OK. Repeat for each key.
3. Click OK to close the dialog.

Avoid `setx GEMINI_API_KEY ...` and `$env:GEMINI_API_KEY = ...`: the key would be saved in your shell history, and in a chat if you run it through an agent.

**macOS / Linux:** add `export GEMINI_API_KEY=...` lines to your shell profile (`~/.zshrc`, `~/.bashrc` or `~/.profile`), edited in a text editor rather than typed into the terminal. Then run `source` on the file, or open a new terminal.

Don't put keys in a `.env` file inside a repository or in this skill folder, where they could be committed. Don't put them in Claude Code's `settings.json` `env` block either, since that file is plain text and may be synced.

**Coming from the MCP server?** Your keys are probably in the `env` block of an MCP config such as `.vscode/mcp.json`. Move them into your user environment as above, and remove them from that file. Once the skill replaces the MCP server, nothing else needs that file.

### 4. Restart and check

Restart VS Code completely (close every window, not just the terminal), so it and the agent it runs pick up the new variables. Then run:

```bash
node scripts/video.mjs check
```

It shows the package version, which yt-dlp it found, each provider variable as `set` or `NOT SET` (never the values), the default providers, and the license tier.

## Using it

Mostly you just talk to Claude and mention the video. The skill triggers on things like:

> "Watch `C:\recordings\login-bug.mp4` and tell me what error shows up."

> "Summarize this talk: `https://www.youtube.com/watch?v=...`"

> "At what point in `demo.mp4` does the presenter mention pricing?"

> "Transcribe `standup.mp4` with speaker labels and save it as notes."

> "Make English subtitles (SRT) for `interview-es.mp4`."

> "Grab screenshots from `demo.mp4` at 1:23 and 2:05."

You can also run the script directly. `<video>` is a local path (quote it if it has spaces), a `file://` URI, a direct `http(s)` link, or a platform link (YouTube, Vimeo, TikTok, Bilibili and others).

```bash
# Local: no keys, nothing uploaded
node scripts/video.mjs info "demo.mp4"                      # duration, resolution, fps, codec, audio
node scripts/video.mjs frames "demo.mp4" --count 8          # 8 frames spread over the video
node scripts/video.mjs frames "demo.mp4" --every 5          # a frame every 5 seconds
node scripts/video.mjs frames "demo.mp4" --at 83,125.5      # frames at exact seconds
node scripts/video.mjs frames "demo.mp4" --scenes           # frames at visual cuts
node scripts/video.mjs frames "demo.mp4" --count 20 --out ./shots

# Provider: needs keys; video or audio is uploaded
node scripts/video.mjs ask "demo.mp4" "What error does the user hit?"
node scripts/video.mjs summarize "demo.mp4" --provider gemini
node scripts/video.mjs find "demo.mp4" "the settings page opens"
node scripts/video.mjs transcribe "talk.mp4" --diarize --save talk.txt
node scripts/video.mjs transcribe "talk.mp4" --format srt --save talk.srt
node scripts/video.mjs transcribe "charla.mp4" --translate --format vtt --save talk-en.vtt

# Cache
node scripts/video.mjs cache status
node scripts/video.mjs cache clear:expired
```

`frames` writes JPEGs into a new folder under your temp directory (or `--out`) and lists each file with its timestamp, so the agent can open the ones it needs. `node scripts/video.mjs help` lists every flag.

## What gets sent where

Only the provider commands upload anything:

- `ask`, `summarize` and `find` send the video, or keyframes from it, to Google (Gemini), MiniMax, Moonshot (Kimi), Alibaba (Qwen), Xiaomi (MiMo) or Z.AI (GLM).
- `transcribe` sends the audio track to Deepgram, AssemblyAI, Groq or Google.
- **Fallback can change the recipient.** If the provider you chose has no key or fails, the package tries the next provider that has a key. To keep a video with one company, set only that company's key.

Screen recordings often show secrets, internal systems or customer data that nobody meant to include. For anything confidential, ask the agent to stay on the local path (`info` and `frames`), where nothing leaves your machine.

Downloaded videos, frames, audio and transcripts are cached in `video-mcp-cache` under your temp directory for up to 30 days (at most 100 videos and 5 GB). `cache status` shows what is stored. `cache clear:all --yes` deletes everything.

## Free tier and Pro

The package has a free tier and a paid Pro tier. Without a Pro license, platform downloads other than YouTube are not available, downloads are capped at 720p, and `summarize` uses at most 50 keyframes. The commands don't fail; they fall back and print a notice starting with ⚡. Local files and direct video URLs work fully on the free tier.

If you have a Pro license, set `VIDEO_MCP_LICENSE_KEY` in your user environment the same way as the API keys. `check` shows whether it is active.

## Optional settings

Everything else is optional and read from the environment: default providers (`VIDEO_MCP_DEFAULT_PROVIDER`, `AUDIO_MCP_DEFAULT_PROVIDER`), model choices, request timeouts, cache limits, yt-dlp cookies for private videos (`YT_DLP_COOKIES_FILE`), and an S3 relay for large local files with GLM, Qwen and MiMo. The full list with defaults is in [references/providers.md](references/providers.md).

For a corporate proxy, set `HTTPS_PROXY` together with `NODE_USE_ENV_PROXY=1`. For a TLS-inspecting proxy, use `NODE_EXTRA_CA_CERTS`.

## Troubleshooting

| Symptom                                        | Fix                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `video-context-mcp-server not found`           | `npm install -g video-context-mcp-server`, or set `VIDEO_MCP_HOME`                                 |
| Keys show `NOT SET` right after setting them   | Restart VS Code completely so it picks up new user environment variables                           |
| Provider command says no API key is configured | Run `check`; set at least one video key (for `ask`/`summarize`/`find`) or audio key (`transcribe`) |
| `ffprobe exited with code 1 … No such file`    | Wrong path. Quote paths with spaces, or use an absolute path.                                      |
| A YouTube or platform link fails               | Update yt-dlp; for private or age-restricted videos, set `YT_DLP_COOKIES_FILE`                     |
| An import error or `is not a function`         | The package changed internally. Run `check`, then update or pin the package version.               |

More cases (GLM error 1210, timeouts on long videos, DRM content) are in [references/providers.md](references/providers.md).

## How it is built

- `SKILL.md` tells the agent when to use the local or the provider path, and how.
- `scripts/video.mjs` is a thin wrapper. It loads the package's tool handlers from the global install, runs one in-process, and writes any images to disk instead of returning them inline. It has no dependencies of its own.
- `references/providers.md` holds provider details, fallback chains, size limits and environment variables.
- The script relies on the package's internal `dist/` layout. It was written against version 2.2.0 and verified on 2.4.1. If a package update breaks it, `check` reports the version.

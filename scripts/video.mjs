#!/usr/bin/env node
// CLI front-end for the video skill. Loads the tool handlers of the globally
// installed video-context-mcp-server package and runs them in-process, so the
// skill gets the MCP's providers, fallback chains, cache and yt-dlp handling
// without running an MCP server. Images are written to disk instead of being
// returned inline, so the agent can open the ones it needs.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const PACKAGE_NAME = "video-context-mcp-server"

const VIDEO_KEYS = {
  gemini: "GEMINI_API_KEY",
  m3: "MINIMAX_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  mimo: "MIMO_API_KEY",
  glm: "Z_AI_API_KEY",
}
const AUDIO_KEYS = {
  deepgram: "DEEPGRAM_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY",
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
}

const HELP = `video: understand videos from the shell (wraps ${PACKAGE_NAME})

Usage: node video.mjs <command> [args] [flags]

Local (no AI provider; video stays on this machine):
  check                              Package, ffmpeg/yt-dlp, which API keys are set
  info <video>                       Duration, resolution, fps, codec, size, audio
  frames <video> [frame flags]       Extract JPEG frames to a folder and list them
  cache <status|path|copy|clear:expired|clear:all> [--dest=DIR] [--yes]

External AI provider (video or audio is uploaded to a third-party API):
  ask <video> "<question>"           Answer a question about the video
  summarize <video>                  Overview, key scenes, timeline
  find <video> "<what>"              Timestamp(s) where something happens
  transcribe <video> [audio flags]   Speech to text with timestamps

<video> is a local path, file:// URI, direct http(s) URL, or a platform URL
(YouTube, Vimeo, TikTok, Bilibili, ... via yt-dlp).

Frame flags:
  --count N          N evenly spaced frames (default mode, default 10, max 100)
  --every SEC        One frame every SEC seconds         (interval mode)
  --at 1,5.5,90      Frames at these seconds             (timestamps mode)
  --scenes [T]       Frames at scene changes, sensitivity T 0.1-0.9 (default 0.3)
  --max N            Write at most N frames (default 100)
  --offset N         Skip the first N frames (paging through long sets)
  --out DIR          Output folder (default: a new folder under the OS temp dir)

Provider flags (ask / summarize / find):
  --provider gemini|m3|kimi|qwen|mimo|glm   Preferred provider; falls back if unavailable

Audio flags (transcribe):
  --provider deepgram|assemblyai|groq|gemini
  --language CODE    BCP-47, e.g. en, es (auto-detected if omitted)
  --diarize          Label speakers (deepgram, assemblyai)
  --translate        Output English (groq, gemini)
  --format text|srt|vtt|json   (default text)
  --save FILE        Write the transcript to FILE and print only a short header

Global flags:
  --quiet            No progress lines on stderr
  --json             Print the raw tool result as JSON (image data omitted)
`

// ── argument parsing ─────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set([
  "quiet",
  "json",
  "diarize",
  "translate",
  "yes",
  "help",
])

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1)
    } else if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
    } else if (name === "scenes") {
      // --scenes takes an optional threshold
      const next = argv[i + 1]
      if (next !== undefined && /^\d*\.?\d+$/.test(next)) {
        flags.scenes = next
        i++
      } else {
        flags.scenes = true
      }
    } else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        fail(`--${name} needs a value`)
      }
      flags[name] = next
      i++
    }
  }
  return { positional, flags }
}

function fail(message) {
  process.stderr.write(`video: ${message}\n`)
  process.exit(2)
}

function toNumber(value, name) {
  const n = Number(value)
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got "${value}"`)
  return n
}

function toInt(value, name) {
  const n = toNumber(value, name)
  if (!Number.isInteger(n)) fail(`--${name} must be a whole number`)
  return n
}

function requireArg(value, what) {
  if (value === undefined || value === "") fail(`missing ${what}. Run "help".`)
  return value
}

function pickProvider(value, allowed) {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) {
    fail(`--provider must be one of ${allowed.join(", ")}`)
  }
  return value
}

// ── locating the package ─────────────────────────────────────────────────────

function findPackageRoot() {
  const candidates = []
  if (process.env.VIDEO_MCP_HOME) candidates.push(process.env.VIDEO_MCP_HOME)
  // npm's default global folder sits next to the node binary
  const nodeDir = path.dirname(process.execPath)
  candidates.push(
    process.platform === "win32"
      ? path.join(nodeDir, "node_modules", PACKAGE_NAME)
      : path.join(nodeDir, "..", "lib", "node_modules", PACKAGE_NAME),
  )
  const found = () =>
    candidates.find((dir) =>
      existsSync(path.join(dir, "dist", "tools", "analyzeVideo.js")),
    )
  if (found()) return found()

  // Custom npm prefix: ask npm (npm.cmd on Windows needs cmd.exe)
  try {
    const globalRoot = (
      process.platform === "win32"
        ? execFileSync(
            process.env.ComSpec || "cmd.exe",
            ["/d", "/c", "npm root -g"],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 15000,
            },
          )
        : execFileSync("npm", ["root", "-g"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 15000,
          })
    ).trim()
    if (globalRoot) candidates.push(path.join(globalRoot, PACKAGE_NAME))
  } catch {
    // npm missing or slow; fall through to the error below
  }
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "dist", "tools", "analyzeVideo.js"))) {
      return dir
    }
  }
  const tried = candidates.length
    ? candidates.join(", ")
    : "(npm root -g failed)"
  fail(
    `${PACKAGE_NAME} not found (looked in: ${tried}).\n` +
      `Install it with:  npm install -g ${PACKAGE_NAME}\n` +
      "Or set VIDEO_MCP_HOME to a built checkout (a folder containing dist/).",
  )
}

let packageRoot
function load(relativePath) {
  return import(
    pathToFileURL(path.join(packageRoot, "dist", relativePath)).href
  )
}

function packageVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ).version
  } catch {
    return "unknown"
  }
}

// ── runtime setup shared by every tool call ──────────────────────────────────

async function prepareRuntime({ quiet }) {
  const logger = await load("utils/logger.js")
  // The handlers report progress through an MCP logging notification. Route
  // it to stderr instead, so stdout carries only the result.
  logger.setLoggerServer({
    sendLoggingMessage: async ({ level, data }) => {
      if (!quiet) process.stderr.write(`[${level}] ${data}\n`)
    },
  })

  // Same license handling as the MCP server: VIDEO_MCP_LICENSE_KEY, if set,
  // is validated offline and online. Without it, free-tier limits apply and
  // the tools fall back with a notice instead of failing.
  const { initLicenseValidation } = await load("utils/license.js")
  await initLicenseValidation()

  const { resolveYtDlpPath } = await load("utils/ytDlpPath.js")
  await resolveYtDlpPath().catch(() => {})
}

async function flushS3Relay() {
  try {
    const relay = await load("services/s3Relay.js")
    if (relay.isS3RelayConfigured() && relay.isS3RelayCleanupEnabled()) {
      await relay.flushRelayKeys()
    }
  } catch {
    // Older versions or no relay: nothing to clean up
  }
}

// ── output ───────────────────────────────────────────────────────────────────

function textItems(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
}

function printJson(result) {
  const redacted = {
    ...result,
    content: (result.content ?? []).map((c) =>
      c.data ? { ...c, data: `<${c.data.length} base64 chars omitted>` } : c,
    ),
  }
  process.stdout.write(JSON.stringify(redacted, null, 2) + "\n")
}

function formatTime(seconds) {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(1).padStart(4, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

// ── commands ─────────────────────────────────────────────────────────────────

async function runTool(file, exportName, params, flags) {
  await prepareRuntime(flags)
  const mod = await load(`tools/${file}`)
  const result = await mod[exportName](params)
  await flushS3Relay()
  return result
}

async function cmdSimple(file, exportName, params, flags) {
  const result = await runTool(file, exportName, params, flags)
  if (flags.json) printJson(result)
  else process.stdout.write(textItems(result).join("\n\n") + "\n")
  return result.isError ? 1 : 0
}

function frameParams(video, flags) {
  const params = { videoPath: video }
  const modes = ["every", "at", "scenes"].filter((f) => flags[f] !== undefined)
  if (modes.length > 1) fail("use only one of --every, --at, --scenes")

  if (flags.at !== undefined) {
    params.mode = "timestamps"
    params.timestamps = String(flags.at)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => toNumber(t, "at"))
    if (!params.timestamps.length) fail("--at needs at least one timestamp")
  } else if (flags.every !== undefined) {
    params.mode = "interval"
    params.intervalSec = toNumber(flags.every, "every")
  } else if (flags.scenes !== undefined) {
    params.mode = "scene"
    if (flags.scenes !== true)
      params.sceneThreshold = toNumber(flags.scenes, "scenes")
  } else {
    params.mode = "even"
    params.count = flags.count !== undefined ? toInt(flags.count, "count") : 10
  }
  params.maxImages = flags.max !== undefined ? toInt(flags.max, "max") : 100
  if (flags.offset !== undefined) params.offset = toInt(flags.offset, "offset")
  return params
}

function localFile(video) {
  const p = video.startsWith("file://") ? fileURLToPath(video) : video
  return /^https?:\/\//i.test(p) || !existsSync(p) ? null : p
}

// Seconds for each written frame, where they can be known: given for
// timestamps mode, offset × interval for interval mode, and approximate for
// even mode (the fps filter spaces frames duration / count apart). Scene mode
// does not report where the cuts were.
async function frameTimes(params, total, video) {
  if (params.mode === "timestamps") {
    return total === params.timestamps.length ? params.timestamps : null
  }
  if (params.mode === "interval") {
    return Array.from({ length: total }, (_, i) => i * params.intervalSec)
  }
  if (params.mode === "even") {
    const local = localFile(video)
    if (!local) return null
    try {
      const { getVideoMetadata } = await load("services/ffmpeg.js")
      const { duration } = await getVideoMetadata(local)
      if (!(duration > 0)) return null
      return Array.from({ length: total }, (_, i) => (i * duration) / total)
    } catch {
      return null
    }
  }
  return null
}

async function cmdFrames(video, flags) {
  const params = frameParams(video, flags)
  const result = await runTool(
    "extractFrames.js",
    "extractFramesTool",
    params,
    flags,
  )
  if (flags.json) {
    printJson(result)
    return result.isError ? 1 : 0
  }
  if (result.isError) {
    process.stdout.write(textItems(result).join("\n") + "\n")
    return 1
  }

  const images = result.content.filter((c) => c.type === "image")
  const texts = textItems(result)
  const totalMatch = /Extracted (\d+) frame/.exec(texts[0] ?? "")
  const total = totalMatch ? Number(totalMatch[1]) : images.length
  const offset = params.offset ?? 0

  const outDir = path.resolve(
    flags.out ??
      path.join(
        tmpdir(),
        "video-skill",
        `${path.parse(localFile(video) ?? "remote").name.replace(/[^\w.-]+/g, "_")}-${params.mode}-${Date.now()}`,
      ),
  )
  await mkdir(outDir, { recursive: true })

  const times = await frameTimes(params, total, video)
  const approx = params.mode === "even" ? "≈" : ""
  const lines = []
  for (let i = 0; i < images.length; i++) {
    const index = offset + i + 1
    const name = `frame-${String(index).padStart(3, "0")}.jpg`
    await writeFile(
      path.join(outDir, name),
      Buffer.from(images[i].data, "base64"),
    )
    const t = times?.[index - 1]
    lines.push(t === undefined ? name : `${name}  ${approx}${formatTime(t)}`)
  }

  const shown =
    images.length === total
      ? `all ${total}`
      : `${images.length} (frames ${offset + 1}-${offset + images.length} of ${total})`
  process.stdout.write(
    `Extracted ${total} frame(s) from ${video} (${params.mode} mode); wrote ${shown} to:\n${outDir}\n\n` +
      lines.join("\n") +
      "\n",
  )
  if (offset + images.length < total) {
    process.stdout.write(
      `\n${total - offset - images.length} more frame(s): rerun with --offset ${offset + images.length}\n`,
    )
  }
  if (params.mode === "scene") {
    process.stdout.write(
      "\nScene mode does not report cut times. To pin one down, use --at around the frame you care about.\n",
    )
  }
  for (const t of texts.slice(1)) {
    if (t.startsWith("Cached frame paths") || t.startsWith("[Pagination]"))
      continue
    process.stdout.write(`\n${t}\n`)
  }
  return 0
}

async function cmdTranscribe(video, flags) {
  const params = { videoPath: video }
  params.provider = pickProvider(flags.provider, Object.keys(AUDIO_KEYS))
  if (flags.language) params.language = flags.language
  if (flags.diarize) params.diarize = true
  if (flags.translate) params.translate = true
  if (flags.format) {
    if (!["text", "srt", "vtt", "json"].includes(flags.format)) {
      fail("--format must be text, srt, vtt or json")
    }
    params.outputFormat = flags.format
  }
  const result = await runTool(
    "transcribeVideo.js",
    "transcribeVideoTool",
    params,
    flags,
  )
  if (flags.json || result.isError || !flags.save) {
    if (flags.json) printJson(result)
    else process.stdout.write(textItems(result).join("\n\n") + "\n")
    return result.isError ? 1 : 0
  }

  // The tool returns a short header followed by the transcript body. Save the
  // body only, so .srt/.vtt files are valid as written.
  const [first, ...rest] = textItems(result)
  const split = first.indexOf("\n\n")
  const header = split === -1 ? "" : first.slice(0, split)
  const body = split === -1 ? first : first.slice(split + 2)
  const target = path.resolve(flags.save)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body.endsWith("\n") ? body : body + "\n", "utf8")
  const lineCount = body.split("\n").length
  process.stdout.write(
    `${header}\n\nSaved transcript (${lineCount} lines, ${body.length} chars) to ${target}\n`,
  )
  for (const t of rest) process.stdout.write(`\n${t}\n`)
  return 0
}

async function cmdCheck() {
  const out = []
  out.push(`Package: ${PACKAGE_NAME} ${packageVersion()} at ${packageRoot}`)
  out.push(`Node: ${process.version}`)

  try {
    const { resolveYtDlpPath } = await load("utils/ytDlpPath.js")
    const r = await resolveYtDlpPath()
    out.push(
      `yt-dlp: ${r.path} (${r.source})${r.warning ? ` WARNING: ${r.warning}` : ""}`,
    )
  } catch (e) {
    out.push(`yt-dlp: not resolved (${e.message})`)
  }

  const status = (name) => (process.env[name] ? "set" : "NOT SET")
  out.push("", "Video providers (fallback order starts at the default):")
  for (const [p, key] of Object.entries(VIDEO_KEYS))
    out.push(`  ${p.padEnd(10)} ${key.padEnd(20)} ${status(key)}`)
  out.push("Audio providers:")
  for (const [p, key] of Object.entries(AUDIO_KEYS))
    out.push(`  ${p.padEnd(10)} ${key.padEnd(20)} ${status(key)}`)

  const { initLicenseValidation, getLicenseInfo } =
    await load("utils/license.js")
  await initLicenseValidation()
  const license = getLicenseInfo()
  out.push(
    "",
    `Default video provider: ${process.env.VIDEO_MCP_DEFAULT_PROVIDER || "gemini"}`,
    `Default audio provider: ${process.env.AUDIO_MCP_DEFAULT_PROVIDER || "deepgram"}`,
    `S3 relay: ${process.env.AWS_S3_BUCKET ? "configured" : "not configured"}`,
    `Pro license: ${license.valid ? "valid" : `not active (free tier${process.env.VIDEO_MCP_LICENSE_KEY ? `: ${license.reason ?? license.onlineReason ?? "invalid"}` : ""})`}`,
    `Cache: ${path.join(tmpdir(), "video-mcp-cache")}`,
  )

  const anyVideo = Object.values(VIDEO_KEYS).some((k) => process.env[k])
  const anyAudio = Object.values(AUDIO_KEYS).some((k) => process.env[k])
  if (!anyVideo || !anyAudio) {
    out.push(
      "",
      "Local commands (info, frames, cache) work without keys.",
      !anyVideo
        ? "ask / summarize / find need at least one video provider key."
        : null,
      !anyAudio ? "transcribe needs at least one audio provider key." : null,
      "Keys are read from the environment of the process that runs this script.",
      "Set them as user environment variables (see the skill's README.md), then",
      "fully restart VS Code / the terminal so new processes inherit them.",
    )
  }
  process.stdout.write(out.filter((l) => l !== null).join("\n") + "\n")
  return 0
}

async function cmdCache(args) {
  const { handleCacheCommand } = await load("commands/cache.js")
  await handleCacheCommand(args)
  return 0
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    process.stdout.write(HELP)
    return 0
  }
  if (command === "cache") {
    packageRoot = findPackageRoot()
    return cmdCache(argv.slice(1))
  }

  const { positional, flags } = parseArgs(argv.slice(1))
  if (flags.help) {
    process.stdout.write(HELP)
    return 0
  }
  packageRoot = findPackageRoot()
  const video = positional[0]
  const videoProviders = Object.keys(VIDEO_KEYS)

  switch (command) {
    case "check":
      return cmdCheck()
    case "info":
      return cmdSimple(
        "getVideoInfo.js",
        "getVideoInfoTool",
        { videoPath: requireArg(video, "<video>") },
        flags,
      )
    case "frames":
      return cmdFrames(requireArg(video, "<video>"), flags)
    case "ask":
      return cmdSimple(
        "analyzeVideo.js",
        "analyzeVideoTool",
        {
          videoPath: requireArg(video, "<video>"),
          question: requireArg(positional.slice(1).join(" "), '"<question>"'),
          provider: pickProvider(flags.provider, videoProviders),
        },
        flags,
      )
    case "summarize":
      return cmdSimple(
        "summarizeVideo.js",
        "summarizeVideoTool",
        {
          videoPath: requireArg(video, "<video>"),
          provider: pickProvider(flags.provider, videoProviders),
        },
        flags,
      )
    case "find":
      return cmdSimple(
        "searchTimestamp.js",
        "searchTimestampTool",
        {
          videoPath: requireArg(video, "<video>"),
          query: requireArg(positional.slice(1).join(" "), '"<what to find>"'),
          provider: pickProvider(flags.provider, videoProviders),
        },
        flags,
      )
    case "transcribe":
      return cmdTranscribe(requireArg(video, "<video>"), flags)
    default:
      fail(`unknown command "${command}". Run "help".`)
  }
}

main()
  .then((code) => {
    // Handlers can leave sockets or timers open; exit once stdout drains.
    process.stdout.write("", () => process.exit(code ?? 0))
  })
  .catch((error) => {
    process.stderr.write(
      `video: ${error instanceof Error ? error.stack : String(error)}\n`,
    )
    process.exit(1)
  })

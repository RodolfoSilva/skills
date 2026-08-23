#!/usr/bin/env node
// Screenshots a running page at an exact CSS size, for diffing against a design export.
// Driven over CDP because --screenshot never fires on a page holding a live websocket:
// the socket keeps the virtual time budget alive forever.

import { spawn } from "node:child_process"
import { globSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const USAGE = `usage: node capture.mjs --url <url> --width <px> --height <px> --out <file.png>
       [--scale 2] [--wait-ms 1500] [--wait-for '<js expression>'] [--before '<js>']`

const SETTLE_MS = 400
const POLL_MS = 250
const POLL_TRIES = 40

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith("--")) throw new Error(`expected a --flag, got: ${key}\n${USAGE}`)
    flags[key.slice(2)] = argv[i + 1]
  }
  return flags
}

function resolveHeadlessShell() {
  if (process.env.CHROME_HEADLESS_SHELL) return process.env.CHROME_HEADLESS_SHELL
  const cached = globSync(
    join(
      process.env.HOME,
      "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
    ),
  )
  const newest = cached.sort().at(-1)
  if (!newest) {
    throw new Error("no chrome-headless-shell found. run: npx playwright install chromium-headless-shell")
  }
  return newest
}

function launchBrowser(port) {
  return spawn(
    resolveHeadlessShell(),
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      // A headless tab counts as backgrounded: timers get throttled, the websocket drops
      // and reconnects, and one-shot UI such as a flash message is gone before the shot.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "pixel-capture-"))}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  )
}

async function debuggerUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      return (await response.json()).webSocketDebuggerUrl
    } catch {
      await sleep(POLL_MS)
    }
  }
  throw new Error("chrome did not open its debugging port")
}

async function attach(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve) => (socket.onopen = resolve))

  let lastId = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }

  const send = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++lastId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })

  const { targetId } = await send("Target.createTarget", { url: "about:blank" })
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
  const call = (method, params = {}) => send(method, params, sessionId)

  await call("Page.enable")
  await call("Runtime.enable")
  return { call, close: () => socket.close() }
}

async function evaluate(call, expression) {
  const { result, exceptionDetails } = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
  return result.value
}

async function waitUntil(call, expression) {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (await evaluate(call, expression)) return
    await sleep(POLL_MS)
  }
  throw new Error(`--wait-for never became true: ${expression}`)
}

async function capture(call, { url, width, height, out, scale, waitMs, waitFor, before }) {
  // A mobile width only exists inside the emulation override, resizing a window does nothing.
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: width < 700,
  })
  await call("Page.navigate", { url })
  await sleep(waitMs)
  if (waitFor) await waitUntil(call, waitFor)
  if (before) await evaluate(call, before)
  await sleep(SETTLE_MS)
  const { data } = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
  writeFileSync(out, Buffer.from(data, "base64"))
}

function readOptions(argv) {
  const flags = parseFlags(argv)
  const options = {
    url: flags.url,
    width: Number(flags.width),
    height: Number(flags.height),
    out: flags.out,
    scale: Number(flags.scale ?? 2),
    waitMs: Number(flags["wait-ms"] ?? 1500),
    waitFor: flags["wait-for"],
    before: flags.before,
  }
  if (!options.url || !options.out || !options.width || !options.height) throw new Error(USAGE)
  return options
}

const options = readOptions(process.argv.slice(2))
const port = 9333 + Math.floor(Math.random() * 400)
const browser = launchBrowser(port)
const session = await attach(await debuggerUrl(port))
try {
  await capture(session.call, options)
  console.log(options.out)
} finally {
  session.close()
  browser.kill()
}

#!/usr/bin/env node
// Waits until Postgres, Redis and the Pact Broker answer.
// A poll, never a fixed sleep. A fixed sleep is slow on a fast machine and it
// fails on a slow machine.
import { setTimeout as sleep } from 'node:timers/promises'
import { tcpUp } from './lib/net.mjs'

const TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS ?? 120_000)
const POLL_MS = 500

async function httpUp(url) {
  // A REF'D timer, not AbortSignal.timeout().
  //
  // AbortSignal.timeout() creates an UNREF'D timer on purpose, so it cannot
  // hold a process open. While undici is still setting up its socket there is
  // then a moment with no live handle at all, the event loop looks empty, and
  // node kills a pending TOP-LEVEL await with exit code 13. It reads as an
  // instant unexplained failure: the script prints two lines and vanishes in
  // 50 ms.
  //
  // A ref'd timer keeps a handle alive for the whole request and still
  // guarantees that the promise settles.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const CHECKS = [
  { name: 'postgres', check: () => tcpUp('127.0.0.1', 5434) },
  { name: 'redis', check: () => tcpUp('127.0.0.1', 6380) },
  {
    name: 'pact-broker',
    check: () => httpUp('http://localhost:9292/diagnostic/status/heartbeat'),
  },
]

const started = Date.now()
const pending = new Map(CHECKS.map((c) => [c.name, c]))

process.stdout.write('waiting for infrastructure')

// One live handle for the whole poll, so the event loop is never empty while
// a check is in flight. See the note in httpUp.
const keepAlive = setInterval(() => {}, 1_000)

try {
  while (pending.size > 0) {
  if (Date.now() - started > TIMEOUT_MS) {
    process.stdout.write('\n')
    console.error(`timeout. still down: ${[...pending.keys()].join(', ')}`)
    console.error('run "docker compose logs" to see why')
    process.exit(1)
  }

  for (const [name, entry] of [...pending]) {
    if (await entry.check()) {
      pending.delete(name)
      process.stdout.write(`\n  ${name} is up`)
    }
  }

  if (pending.size > 0) {
    process.stdout.write('.')
    await sleep(POLL_MS)
  }
}

} finally {
  clearInterval(keepAlive)
}

process.stdout.write(`\nall infrastructure is ready in ${Date.now() - started} ms\n`)

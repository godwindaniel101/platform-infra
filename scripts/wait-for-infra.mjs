#!/usr/bin/env node
// Waits until Postgres, Redis and the Pact Broker answer.
// A poll, never a fixed sleep. A fixed sleep is slow on a fast machine and it
// fails on a slow machine.
import { setTimeout as sleep } from 'node:timers/promises'
import { tcpUp } from './lib/net.mjs'

const TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS ?? 120_000)
const POLL_MS = 500

async function httpUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return res.ok
  } catch {
    return false
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

process.stdout.write(`\nall infrastructure is ready in ${Date.now() - started} ms\n`)

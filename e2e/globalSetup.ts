import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tcpUp } from '../scripts/lib/net.mjs'

/**
 * Starts the full stack once for the whole scenario run, then stops it.
 *
 * This is the only place that knows about both repositories. Neither service
 * repository may import the other, so the harness lives here.
 *
 * The services run with NODE_ENV=test, against the TEST databases and Redis
 * database 2. A scenario run must never touch the data of a local demo.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const LOG_DIR = path.resolve(__dirname, '..', 'logs')

const SWITCH_PORT = Number(process.env.E2E_SWITCH_PORT ?? 4021)
const DISBURSEMENT_PORT = Number(process.env.E2E_DISBURSEMENT_PORT ?? 4020)

const PG = 'postgres://pact:pact@localhost:5434'
// Database 2. The provider pact tests use 1, and a demo uses 0.
const REDIS = 'redis://localhost:6380/2'

const children: ChildProcess[] = []

export async function setup(): Promise<void> {
  fs.mkdirSync(LOG_DIR, { recursive: true })

  if (process.env.E2E_USE_RUNNING_SERVICES === 'true') {
    console.log('using the services that are already running')
    await waitForReady()
    return
  }

  await assertInfraIsUp()
  await assertPortsAreFree()

  // The switch first. The disbursement service can start without it, but the
  // first scenario would then see a fallback decision and read as a failure.
  children.push(
    start('switch-service', {
      NODE_ENV: 'test',
      PORT: String(SWITCH_PORT),
      DATABASE_URL: `${PG}/switch_test_db`,
      DATABASE_READ_URL: `${PG}/switch_test_db`,
      REDIS_URL: REDIS,
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      // A scenario needs an exact answer, and exploration is random. The
      // scenarios that test exploration turn it on for themselves.
      EXPLORATION_RATE: process.env.E2E_EXPLORATION_RATE ?? '0.1',
    }),
  )

  children.push(
    start('disbursement-service', {
      NODE_ENV: 'test',
      PORT: String(DISBURSEMENT_PORT),
      DATABASE_URL: `${PG}/disbursement_test_db`,
      DATABASE_READ_URL: `${PG}/disbursement_test_db`,
      REDIS_URL: REDIS,
      SWITCH_BASE_URL: `http://127.0.0.1:${SWITCH_PORT}`,
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      // A short poll, so a scenario does not wait for the metrics path.
      OUTBOX_POLL_MS: '100',
    }),
  )

  await waitForReady()
}

export async function teardown(): Promise<void> {
  for (const child of children) {
    // SIGTERM, never SIGKILL. The graceful shutdown is part of what the
    // scenarios prove, and a hard kill would leave a payout in flight.
    child.kill('SIGTERM')
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve()
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 8_000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        }),
    ),
  )
}

function start(repo: string, env: Record<string, string>): ChildProcess {
  const cwd = path.join(ROOT, repo)
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(
      `cannot find the repository ${repo} at ${cwd}. ` +
        'the three repositories must sit next to each other',
    )
  }
  const entry = path.join(cwd, 'dist', 'server.js')
  if (!fs.existsSync(entry)) {
    throw new Error(
      `${repo} is not built. run "npm run build" in ${cwd} first, ` +
        'because the harness starts the built service, not the sources',
    )
  }

  const log = fs.openSync(path.join(LOG_DIR, `${repo}.log`), 'w')
  const child = spawn('node', [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', log, log],
  })
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(
        `${repo} stopped with code ${code}. read platform-infra/logs/${repo}.log`,
      )
    }
  })
  return child
}

/** A poll, never a fixed sleep. */
async function waitForReady(): Promise<void> {
  const targets = [
    { name: 'switch-service', url: `http://127.0.0.1:${SWITCH_PORT}/health/ready` },
    {
      name: 'disbursement-service',
      url: `http://127.0.0.1:${DISBURSEMENT_PORT}/health/ready`,
    },
  ]
  const deadline = Date.now() + 60_000

  for (const target of targets) {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `${target.name} was not ready in time. read platform-infra/logs/`,
        )
      }
      try {
        const response = await fetch(target.url, {
          signal: AbortSignal.timeout(1_500),
        })
        if (response.ok) break
      } catch {
        // Not up yet. Try again.
      }
      await sleep(200)
    }
  }
}

/**
 * Refuses to start when something already holds a port.
 *
 * Without this check the new service fails to bind, the old one answers the
 * health poll, and the whole run silently tests the OLD build. That mistake
 * costs hours, because every result looks real.
 */
async function assertPortsAreFree(): Promise<void> {
  const ports: Array<[string, number]> = [
    ['switch-service', SWITCH_PORT],
    ['disbursement-service', DISBURSEMENT_PORT],
  ]
  for (const [name, port] of ports) {
    if (await tcpUp('127.0.0.1', port)) {
      throw new Error(
        `port ${port} is already in use, so ${name} cannot start there.\n` +
          'a service from an earlier run is probably still alive. stop it with:\n' +
          `  lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill\n` +
          'or set E2E_USE_RUNNING_SERVICES=true to test against what is running.',
      )
    }
  }
}

async function assertInfraIsUp(): Promise<void> {
  const checks: Array<[string, number]> = [
    ['postgres', 5434],
    ['redis', 6380],
  ]
  for (const [name, port] of checks) {
    if (!(await tcpUp('127.0.0.1', port))) {
      throw new Error(
        `${name} is not listening on ${port}. run "docker compose up -d" in platform-infra`,
      )
    }
  }
}

import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  reset,
  payout,
  payoutBatch,
  totalSamples,
  waitFor,
  outboxPending,
} from './helpers/harness'

/**
 * What happens when a part breaks.
 *
 * The rule that these scenarios protect: the money path never waits for the
 * metrics path, and it never fails because of it.
 *
 * The Redis scenario stops a container, so it disturbs anything else that
 * uses that container. It runs only with E2E_CHAOS=true.
 */

const CHAOS = process.env.E2E_CHAOS === 'true'
const REDIS_CONTAINER = 'pri-redis'

beforeEach(async () => {
  await reset()
}, 30_000)

afterAll(() => {
  // Never leave the container down, whatever happened above.
  if (CHAOS) tryDocker(['start', REDIS_CONTAINER])
})

describe('the metrics path is not the money path', () => {
  it('keeps the payout fast even when the window is empty', async () => {
    // A cold system has no metrics at all. The payout must not wait for them.
    const started = Date.now()
    const result = await payout()
    const elapsed = Date.now() - started

    expect(result.status).toBe(201)
    // The rails take up to about 700 ms by themselves. The routing decision
    // must add very little on top.
    expect(elapsed).toBeLessThan(5_000)
  })
})

describe.runIf(CHAOS)('redis is down', () => {
  it('still sends every payout, and loses no outcome', async () => {
    // Prove the system is healthy first.
    await payoutBatch(10, 5)
    await waitFor(async () => (await outboxPending()) === 0, {
      timeoutMs: 15_000,
      message: 'the outbox did not empty before the chaos started',
    })

    tryDocker(['stop', REDIS_CONTAINER])
    try {
      // The switch cannot read the window, so it routes in degraded mode. The
      // disbursement service cannot publish, so the events stay in the outbox.
      const results = await payoutBatch(20, 5)

      for (const result of results) {
        expect(result.status).toBe(201)
        expect(result.transaction.channelId).toBeTruthy()
        expect(['success', 'failed']).toContain(result.transaction.status)
      }

      // Nothing is lost. The rows wait in Postgres.
      const pending = await outboxPending()
      expect(pending).toBeGreaterThan(0)
    } finally {
      tryDocker(['start', REDIS_CONTAINER])
    }

    // When Redis comes back the publisher drains the outbox by itself, and
    // the switch applies every outcome that waited.
    await waitFor(async () => (await outboxPending()) === 0, {
      timeoutMs: 60_000,
      message: 'the outbox did not drain after redis came back',
    })

    // Redis runs with no persistence, so the restart also removed the stream,
    // the consumer group and the window that existed before the outage. Only
    // the events that waited in the outbox come back, and the count is
    // therefore about 20, not 30.
    //
    // The consumer must make the group again by itself. Without that repair
    // it reads NOGROUP forever and the routing goes blind while the health
    // check still reports "running".
    await waitFor(
      async () => (await totalSamples()) >= 15,
      {
        timeoutMs: 60_000,
        message: 'the switch did not catch up after redis came back',
      },
    )
  }, 240_000)
})

describe.skipIf(CHAOS)('redis chaos is off', () => {
  it('reports that the scenario was not run', () => {
    // A silent skip reads as "covered". Say it out loud instead.
    console.log(
      'skipped: the "redis is down" scenario stops a container. ' +
        'run it with E2E_CHAOS=true npm run e2e',
    )
    expect(CHAOS).toBe(false)
  })
})

function tryDocker(args: string[]): void {
  try {
    execFileSync('docker', args, { stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      `could not run "docker ${args.join(' ')}": ${(error as Error).message}`,
    )
  }
}

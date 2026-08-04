import { describe, it, expect, beforeEach } from 'vitest'
import Redis from 'ioredis'
import {
  reset,
  payout,
  payoutBatch,
  channels,
  channel,
  totalSamples,
  waitFor,
  waitForOutcomes,
  outboxPending,
} from './helpers/harness'

/**
 * The scenarios that protect money. They come FIRST in the file order, and
 * nobody skips them.
 *
 * A payout must not double, must not vanish, and must not depend on the
 * metrics path.
 */

const REDIS_URL = 'redis://localhost:6380/2'

beforeEach(async () => {
  await reset()
}, 30_000)

describe('the happy path', () => {
  it('routes, sends and records one payout, then feeds the switch', async () => {
    const result = await payout({ reference: 'E2E-HAPPY-1' })

    expect(result.status).toBe(201)
    expect(result.replayed).toBe(false)
    // The switch gave the channel. A fallback here would mean the switch was
    // not reachable, and the scenario would prove nothing about routing.
    expect(result.routing.source).toBe('switch')
    expect(['RAIL-A', 'RAIL-B', 'RAIL-C']).toContain(result.routing.channelId)
    expect(['success', 'failed']).toContain(result.transaction.status)
    expect(result.transaction.latencyMs).toBeGreaterThan(0)

    // The outcome travels over Redis and lands in the window of the switch.
    await waitForOutcomes(1)
    expect(await totalSamples()).toBe(1)

    const all = await channels()
    const chosen = all.find((c) => c.id === result.routing.channelId)
    expect((chosen?.success ?? 0) + (chosen?.failure ?? 0)).toBe(1)
  })

  it('gives every payout a channel and an outcome', async () => {
    const results = await payoutBatch(40, 8)

    expect(results).toHaveLength(40)
    for (const result of results) {
      expect(result.status).toBe(201)
      expect(result.routing.channelId).toBeTruthy()
      expect(result.transaction.channelId).toBe(result.routing.channelId)
    }

    await waitForOutcomes(40)
    // Exactly 40. More would mean an event counted twice, fewer would mean an
    // event was lost. Both are faults that cost money.
    expect(await totalSamples()).toBe(40)
  })
})

describe('a duplicate reference', () => {
  it('creates one payout, not two', async () => {
    const reference = 'E2E-DUPLICATE-1'

    const first = await payout({ reference })
    const second = await payout({ reference })

    expect(first.status).toBe(201)
    expect(first.replayed).toBe(false)

    // A retry after a timeout is normal. The client must get the same answer,
    // not an error and not a second payout.
    expect(second.status).toBe(200)
    expect(second.replayed).toBe(true)
    expect(second.transaction.id).toBe(first.transaction.id)
    expect(second.transaction.channelId).toBe(first.transaction.channelId)

    await waitForOutcomes(1)
    expect(await totalSamples()).toBe(1)
  })

  it('stays correct when the same reference arrives many times at once', async () => {
    const reference = 'E2E-DUPLICATE-RACE'
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => payout({ reference })),
    )

    const created = attempts.filter((a) => a.status === 201)
    const replayed = attempts.filter((a) => a.status === 200)

    // Exactly one wins the unique index. The others read the row it wrote.
    expect(created).toHaveLength(1)
    expect(replayed).toHaveLength(7)
    const ids = new Set(attempts.map((a) => a.transaction.id))
    expect(ids.size).toBe(1)
  })
})

describe('a repeated outcome event', () => {
  it('moves the counters once, not twice', async () => {
    const result = await payout({ reference: 'E2E-REPLAY-1' })
    await waitForOutcomes(1)

    const before = await channel(result.routing.channelId)
    const beforeTotal = before.success + before.failure
    expect(beforeTotal).toBe(1)

    // Put the SAME event on the stream again, exactly as a crash between the
    // Redis write and the outbox update would.
    const redis = new Redis(REDIS_URL)
    try {
      const entries = (await redis.xrange('txn.outcomes', '-', '+')) as Array<
        [string, string[]]
      >
      expect(entries.length).toBeGreaterThan(0)
      const fields = entries[entries.length - 1]?.[1] ?? []
      await redis.xadd('txn.outcomes', '*', ...fields)

      await waitFor(
        async () => {
          const after = await channel(result.routing.channelId)
          return after.success + after.failure === beforeTotal
        },
        {
          timeoutMs: 8_000,
          message: 'the repeated event changed the counters',
        },
      )
    } finally {
      await redis.quit()
    }

    const after = await channel(result.routing.channelId)
    // The guard on the event identifier is the reason this holds. Without it
    // one replayed failure counts twice and opens a breaker that should stay
    // shut.
    expect(after.success + after.failure).toBe(beforeTotal)
  })
})

describe('the outbox', () => {
  it('empties after a batch, so no outcome is left behind', async () => {
    await payoutBatch(25, 8)
    await waitFor(async () => (await outboxPending()) === 0, {
      timeoutMs: 15_000,
      message: 'the outbox did not empty',
    })
    expect(await outboxPending()).toBe(0)
  })
})

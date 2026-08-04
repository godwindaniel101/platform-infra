import { describe, it, expect, beforeEach } from 'vitest'
import {
  reset,
  payout,
  payoutBatch,
  channel,
  setRail,
  perfectRail,
  setEnabled,
  onlyChannel,
  advanceClock,
  shareSince,
  waitFor,
  waitForOutcomes,
  nowIso,
  SWITCH,
} from './helpers/harness'

/**
 * The behaviour that the whole system exists for.
 *
 * A contract test proves the SHAPE of the wire. Nothing in a pact test can
 * answer the question below, and only an end-to-end test can:
 *
 *   RAIL-C starts failing. Does the switch move the traffic, and how fast?
 */

/** One second past the 30 s breaker wait. */
const PAST_BREAKER_WAIT_MS = 31_000

/**
 * The preamble that every breaker-recovery scenario shares: one channel, a rail
 * that is hard down, enough payouts to fill the window, and a wait until the
 * breaker opens.
 */
async function openBreakerOn(channelId: string): Promise<void> {
  await onlyChannel(channelId)
  await setRail(channelId, { hardDown: true })
  await payoutBatch(30, 5)
  await waitFor(
    async () => (await channel(channelId)).breakerState === 'OPEN',
    { timeoutMs: 20_000, message: `the ${channelId} breaker did not open` },
  )
}

beforeEach(async () => {
  await reset()
}, 30_000)

describe('traffic shift', () => {
  it('moves the traffic off a channel that starts failing', async () => {
    // Warm the window. With no data every channel is cold, and the cheapest
    // channel wins on the cost part of the score.
    const warmMark = nowIso()
    await payoutBatch(90, 10)
    await waitForOutcomes(90)

    // Degrade the channel that ACTUALLY carried the traffic, not the one that
    // ranks first now. The rank can already have moved, and a channel that
    // received only exploration traffic has nothing to shift away.
    const before = await shareSince(warmMark)
    const busiest = [...before.channels].sort((a, b) => b.total - a.total)[0]
    expect(busiest).toBeDefined()
    const target = busiest!.channelId
    expect(before.shareOf(target)).toBeGreaterThan(0.25)

    // Break it.
    await setRail(target, { failureRate: 0.9 })
    const afterMark = nowIso()

    await payoutBatch(200, 10)
    await waitForOutcomes(200, { timeoutMs: 30_000 })

    // Take the sample from payouts that STARTED after the change. A mixed
    // sample hides the shift.
    const after = await shareSince(afterMark)
    expect(after.total).toBeGreaterThan(100)
    expect(after.shareOf(target)).toBeLessThan(0.25)
  }, 180_000)
})

describe('the circuit breaker', () => {
  it('opens when a channel proves that it is bad', async () => {
    await onlyChannel('RAIL-C')
    await setRail('RAIL-C', { hardDown: true })

    // Every payout now goes to RAIL-C, so the window fills fast and the
    // breaker gets the samples it needs.
    await payoutBatch(30, 5)
    await waitForOutcomes(25, { timeoutMs: 25_000 })

    await waitFor(
      async () => (await channel('RAIL-C')).breakerState === 'OPEN',
      { timeoutMs: 20_000, message: 'the RAIL-C breaker did not open' },
    )

    const blocked = await channel('RAIL-C')
    expect(blocked.breakerState).toBe('OPEN')
    expect(blocked.eligible).toBe(false)
    expect(blocked.ineligibleReason).toBe('breaker-open')
  }, 120_000)

  it('does not open on a few failures', async () => {
    await onlyChannel('RAIL-B')
    await setRail('RAIL-B', { hardDown: true })

    // Fewer payouts than the minimum. Two failures out of two is not proof,
    // and an early block starves a channel that is still good.
    await payoutBatch(5, 1)
    await waitForOutcomes(5)

    const still = await channel('RAIL-B')
    expect(still.samples).toBeLessThan(20)
    expect(still.breakerState).toBe('CLOSED')
  }, 90_000)

  it('goes to half open after the wait, without any traffic', async () => {
    await openBreakerOn('RAIL-C')

    // Let every outcome of the batch land BEFORE the clock moves.
    //
    // An outcome that arrives after the breaker turns half open counts as a
    // failed probe and opens the breaker again, with a fresh wait. The test
    // would then fail for a reason that has nothing to do with what it
    // measures.
    await waitForOutcomes(30, { timeoutMs: 25_000 })

    // Repair the rail BEFORE the wait ends. Half open is a passing state: the
    // first probe decides at once whether it closes or opens again. With a
    // healthy rail the probe succeeds and the state rests at half open.
    //
    // failureRate 0, not the natural rate of 8%. A probe that fails by chance
    // sends the breaker back to OPEN for another 30 seconds, and the scenario
    // would fail for a reason it does not measure.
    await perfectRail('RAIL-C')

    // Move the clock instead of waiting 30 real seconds.
    await advanceClock(PAST_BREAKER_WAIT_MS)
    await setEnabled('RAIL-A', true)

    // The transition happens INSIDE a routing decision, so the test must keep
    // making decisions. A blocked channel receives no traffic of its own, and
    // that is the point: the breaker must still move on time.
    await waitFor(
      async () => {
        await payout()
        return (await channel('RAIL-C')).breakerState !== 'OPEN'
      },
      {
        timeoutMs: 20_000,
        intervalMs: 200,
        message: 'the RAIL-C breaker did not leave the OPEN state',
      },
    )

    const probing = await channel('RAIL-C')
    // Half open, or already closed if the probes came fast. Either answer
    // proves the point: the breaker left OPEN by itself, on time, with no
    // traffic of its own.
    expect(['HALF_OPEN', 'CLOSED']).toContain(probing.breakerState)
    expect(probing.eligible).toBe(true)
  }, 120_000)

  it('sends at most one probe while it is half open', async () => {
    await openBreakerOn('RAIL-C')

    // Every outcome must land before the clock moves. See the note in the
    // scenario above.
    await waitForOutcomes(30, { timeoutMs: 25_000 })

    // A rail that never fails, so a probe cannot re-open the breaker by
    // chance in the middle of the test.
    await perfectRail('RAIL-C')
    await advanceClock(PAST_BREAKER_WAIT_MS)
    await setEnabled('RAIL-A', true)

    await waitFor(
      async () => {
        await payout()
        return (await channel('RAIL-C')).breakerState === 'HALF_OPEN'
      },
      {
        timeoutMs: 20_000,
        intervalMs: 200,
        message: 'the breaker did not go to half open',
      },
    )

    // A slow probe holds the single slot for the whole burst. Without the
    // lock, a burst of payouts would all pour into a rail that is still bad.
    await setRail('RAIL-C', { extraLatencyMs: 3_000 })

    const mark = nowIso()
    await payoutBatch(40, 12)

    const share = await shareSince(mark)
    const onProbe = share.channels.find((c) => c.channelId === 'RAIL-C')?.total ?? 0
    expect(onProbe).toBeLessThanOrEqual(1)
  }, 150_000)

  it('closes again when the channel recovers', async () => {
    await openBreakerOn('RAIL-C')

    // Every outcome must land before the clock moves, or a late failed probe
    // re-opens the breaker and the recovery starts again.
    await waitForOutcomes(30, { timeoutMs: 25_000 })

    // A rail that never fails, not merely the normal rail.
    //
    // `repairRail` restores the NATURAL failure rate of RAIL-C, which is 8%.
    // The breaker needs 3 CONSECUTIVE good probes, so at 8% one probe in
    // twelve throws the progress away and adds another 30 second wait. This
    // scenario measures the recovery mechanism, not probability, so the noise
    // has no place in it.
    //
    // Note what this reveals about the real setting: on a rail with a normal
    // failure rate, `BREAKER_PROBES_TO_CLOSE=3` makes recovery slow. That is a
    // tuning decision, and the scenario below is where you would see it.
    await perfectRail('RAIL-C')
    await advanceClock(PAST_BREAKER_WAIT_MS)

    // The transition happens INSIDE a routing decision, so the wait must keep
    // making them. RAIL-C is the only channel, so each payout takes the probe
    // slot in turn, one at a time, because the slot allows exactly one.
    await waitFor(
      async () => {
        const state = (await channel('RAIL-C')).breakerState
        if (state === 'CLOSED') return true
        // A breaker that fell back to OPEN needs its wait again.
        if (state === 'OPEN') await advanceClock(PAST_BREAKER_WAIT_MS)
        await payout()
        return (await channel('RAIL-C')).breakerState === 'CLOSED'
      },
      {
        timeoutMs: 40_000,
        intervalMs: 100,
        message: 'the RAIL-C breaker never closed after the repair',
      },
    )

    const healed = await channel('RAIL-C')
    expect(healed.eligible).toBe(true)
  }, 180_000)
})

describe('a channel that the disbursement service cannot reach', () => {
  it('is never offered, because the switch selects from what the caller supports', async () => {
    // THE INVARIANT.
    //
    // The switch learns about a channel that has no rail behind it. This is the
    // ordinary case: somebody adds a channel to switch_db before the rail
    // adapter ships in the other repository.
    //
    // The disbursement service sends `supportedChannels` on every request, so
    // the switch selects from the intersection. It CANNOT answer with
    // RAIL-GHOST, and the payout is never aimed at a rail that does not exist.
    await fetch(`${SWITCH}/internal/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channels: [{ id: 'RAIL-GHOST', name: 'Ghost Rail', cost: 0.1, enabled: true }],
      }),
    })
    await onlyChannel('RAIL-GHOST')

    const result = await payout()

    // The switch has nothing it may offer, so it answers 503
    // NO_ELIGIBLE_CHANNEL, which the HTTP pact already covers. The caller then
    // falls back, and the money still moves.
    expect(result.status).toBe(201)
    expect(result.routing.source).toBe('fallback')
    expect(result.routing.fallbackReason).toBe('http-error')
    expect(result.routing.channelId).toBe('RAIL-A')

    // The old behaviour was a payout ROUTED to RAIL-GHOST and refused by the
    // caller's own guard. That guard still exists as defence in depth, but it
    // must no longer be the thing that saves the payout.
    expect(result.routing.fallbackReason).not.toContain('unknown-channel')
  }, 90_000)
})

describe('no channel at all', () => {
  it('still sends the payout, on the fallback channel', async () => {
    for (const id of ['RAIL-A', 'RAIL-B', 'RAIL-C']) await setEnabled(id, false)

    const result = await payout()

    // The switch answers 503 NO_ELIGIBLE_CHANNEL, which is the third
    // interaction of the HTTP pact. A routing opinion is an improvement, not
    // a requirement, so the money still moves.
    expect(result.status).toBe(201)
    expect(result.routing.source).toBe('fallback')
    expect(result.routing.fallbackReason).toBe('http-error')
    expect(result.routing.channelId).toBe('RAIL-A')
  }, 60_000)
})

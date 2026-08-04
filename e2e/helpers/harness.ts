/**
 * The helpers that every scenario uses.
 *
 * Rules from the e2e-harness skill:
 *   - Drive load through the real HTTP interface, never through an internal
 *     function.
 *   - Wait for a CONDITION, never for a duration.
 *   - Move the test clock instead of waiting for the window in real time.
 *   - Reset to a known state before each scenario, and never drop the database.
 */

import { setTimeout as sleep } from 'node:timers/promises'

export const SWITCH = `http://127.0.0.1:${process.env.E2E_SWITCH_PORT ?? 4021}`
export const DISBURSEMENT = `http://127.0.0.1:${
  process.env.E2E_DISBURSEMENT_PORT ?? 4020
}`

export const DEFAULT_CHANNELS = [
  { id: 'RAIL-A', name: 'Alpha Bank Rail', cost: 1.2, enabled: true },
  { id: 'RAIL-B', name: 'Beta Payments Rail', cost: 1.0, enabled: true },
  { id: 'RAIL-C', name: 'Gamma Switch Rail', cost: 0.8, enabled: true },
]

export interface ChannelHealth {
  id: string
  score: number
  rank: number
  successRate: number
  p95Ms: number | null
  samples: number
  coldStart: boolean
  eligible: boolean
  ineligibleReason: string | null
  success: number
  failure: number
  breakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  probeSuccess: number
}

export interface PayoutResult {
  status: number
  transaction: {
    id: string
    reference: string
    status: string
    channelId: string | null
    latencyMs: number | null
    errorCode: string | null
  }
  routing: {
    channelId: string
    decisionId: string
    source: 'switch' | 'fallback'
    strategy: string
    fallbackReason: string | null
  }
  replayed: boolean
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${response.status} ${text}`)
  }
  return (await response.json()) as T
}

/**
 * Puts both services back to a known state.
 *
 * The order matters: stop the load first, or a payout in flight writes into
 * the state that has just been cleared.
 */
export async function reset(): Promise<void> {
  await json(`${DISBURSEMENT}/simulator/load`, { method: 'DELETE' }).catch(() => null)
  await json(`${DISBURSEMENT}/internal/reset`, { method: 'POST', body: '{}' })
  await json(`${SWITCH}/internal/reset`, { method: 'POST', body: '{}' })
  await json(`${SWITCH}/internal/seed`, {
    method: 'POST',
    body: JSON.stringify({ channels: DEFAULT_CHANNELS }),
  })
}

/** Moves the test clock of the switch. The window then slides at once. */
export async function advanceClock(ms: number): Promise<void> {
  await json(`${SWITCH}/internal/clock`, {
    method: 'POST',
    body: JSON.stringify({ advanceMs: ms }),
  })
}

export async function channels(): Promise<ChannelHealth[]> {
  const body = await json<{ channels: ChannelHealth[] }>(`${SWITCH}/channels`)
  return body.channels
}

/** Every outcome that the switch window holds, over all channels. */
export async function totalSamples(): Promise<number> {
  return (await channels()).reduce((sum, c) => sum + c.success + c.failure, 0)
}

export async function channel(id: string): Promise<ChannelHealth> {
  const all = await channels()
  const found = all.find((c) => c.id === id)
  if (!found) throw new Error(`no channel ${id}`)
  return found
}

export async function setRail(
  railId: string,
  patch: { failureRate?: number | null; extraLatencyMs?: number; hardDown?: boolean },
): Promise<void> {
  await json(`${DISBURSEMENT}/simulator/rails/${railId}`, {
    method: 'POST',
    body: JSON.stringify(patch),
  })
}

export async function repairRail(railId: string): Promise<void> {
  await setRail(railId, { failureRate: null, extraLatencyMs: 0, hardDown: false })
}

/**
 * A rail that never fails, not merely the normal rail.
 *
 * `repairRail` restores the NATURAL failure rate, and a probe that fails by
 * chance sends a breaker back to OPEN. A scenario that measures a mechanism
 * has no place for that noise.
 */
export async function perfectRail(railId: string): Promise<void> {
  await setRail(railId, { failureRate: 0, extraLatencyMs: 0, hardDown: false })
}

/** Turns a channel on or off in the switch. */
export async function setEnabled(channelId: string, enabled: boolean): Promise<void> {
  await json(`${SWITCH}/channels/${channelId}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

/** Sends every payout to one channel, by turning the others off. */
export async function onlyChannel(channelId: string): Promise<void> {
  for (const id of ['RAIL-A', 'RAIL-B', 'RAIL-C']) {
    await setEnabled(id, id === channelId)
  }
}

let sequence = 0

/** One payout, through the real HTTP endpoint. */
export async function payout(
  overrides: Partial<{
    reference: string
    amountMinor: number
    currency: string
    bankCode: string
    accountNumber: string
  }> = {},
): Promise<PayoutResult> {
  sequence += 1
  const body = {
    reference: overrides.reference ?? `E2E-${Date.now()}-${sequence}`,
    amountMinor: overrides.amountMinor ?? 250_000,
    currency: overrides.currency ?? 'NGN',
    bankCode: overrides.bankCode ?? '058',
    accountNumber: overrides.accountNumber ?? '0123456789',
    corridor: 'NGN_BANK',
  }
  const response = await fetch(`${DISBURSEMENT}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const parsed = (await response.json()) as Omit<PayoutResult, 'status'>
  return { ...parsed, status: response.status }
}

/**
 * Sends `count` payouts with at most `concurrency` in flight.
 *
 * A burst of everything at once measures the machine, not the routing.
 */
export async function payoutBatch(
  count: number,
  concurrency = 10,
): Promise<PayoutResult[]> {
  const results: PayoutResult[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= count) return
      results.push(await payout())
    }
  })
  await Promise.all(workers)
  return results
}

export interface ShareRow {
  channelId: string
  total: number
  success: number
  failed: number
  share: number
}

/**
 * The share of payouts for each channel since a moment.
 *
 * Take the "after" sample from payouts that started AFTER the change. A mixed
 * sample hides the shift.
 */
export async function shareSince(sinceIso: string): Promise<{
  total: number
  channels: ShareRow[]
  shareOf: (channelId: string) => number
}> {
  const body = await json<{ total: number; channels: ShareRow[] }>(
    `${DISBURSEMENT}/transactions/share?since=${encodeURIComponent(sinceIso)}`,
  )
  return {
    ...body,
    shareOf: (channelId: string) =>
      body.channels.find((c) => c.channelId === channelId)?.share ?? 0,
  }
}

export async function outboxPending(): Promise<number> {
  const body = await json<{ outboxPending: number }>(`${DISBURSEMENT}/health/ready`)
  return body.outboxPending
}

/** Waits until the switch has applied every outcome that is on the way. */
export async function waitForOutcomes(
  expectedTotalSamples: number,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await waitFor(
    async () => {
      if ((await outboxPending()) > 0) return false
      return (await totalSamples()) >= expectedTotalSamples
    },
    {
      timeoutMs: options.timeoutMs ?? 20_000,
      message: `the switch did not apply ${expectedTotalSamples} outcomes`,
    },
  )
}

/**
 * Waits for a condition, with a message that names what was expected.
 *
 * A failure message that names the expected state saves an hour of reading
 * logs.
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 150
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) {
      const dump = await describeState().catch(() => 'the dump could not be read')
      throw new Error(
        `${options.message ?? 'the condition was never true'} ` +
          `inside ${timeoutMs} ms\n\nstate at the failure:\n${dump}`,
      )
    }
    await sleep(intervalMs)
  }
}

/**
 * Prints the state before anyone guesses.
 *
 * A pending count that grows means the switch consumer stopped. That is the
 * most common cause of a stuck scenario.
 */
export async function describeState(): Promise<string> {
  const dump = await json<{
    now: string
    clockOffsetMs: number
    window: Array<{
      channelId: string
      success: number
      failure: number
      sampleCount: number
      breaker?: { state: string; probeSuccess: number }
    }>
    stream: { length: number; groups: unknown[] }
  }>(`${SWITCH}/internal/dump`)

  const lines = [
    `  clock ${dump.now} (offset ${dump.clockOffsetMs} ms)`,
    `  outcome stream length ${dump.stream.length}`,
    `  outbox pending ${await outboxPending().catch(() => -1)}`,
  ]
  for (const row of dump.window) {
    lines.push(
      `  ${row.channelId}: success ${row.success} failure ${row.failure} ` +
        `samples ${row.sampleCount} breaker ${row.breaker?.state ?? '?'} ` +
        `probes ${row.breaker?.probeSuccess ?? 0}`,
    )
  }
  lines.push(`  groups ${JSON.stringify(dump.stream.groups)}`)
  return lines.join('\n')
}

export function nowIso(): string {
  return new Date().toISOString()
}

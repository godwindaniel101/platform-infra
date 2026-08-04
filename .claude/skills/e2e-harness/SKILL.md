---
name: e2e-harness
description: Rules for the end-to-end scenarios in the platform-infra repository. Use this skill when you start the full stack, seed channels, drive load, or assert that the switch moves traffic away from a bad channel. Trigger on "e2e", "end to end", "scenario", "docker compose up", "load generator", "traffic shift", "smoke test", "full stack".
---

# The end-to-end harness

The harness lives in `platform-infra`. It is the only place that knows about
both services. It proves behaviour. A contract test proves shape.

## What each test layer proves

| Layer | Question it answers | Where it runs |
|-------|--------------------|---------------|
| Unit | Is the maths right? | Each service repository, no docker |
| Contract | Do the two services agree on the wire? | Each service repository, plus the broker |
| Integration | Does the code talk to Redis and Postgres correctly? | Each service repository, with docker |
| End to end | Does the switch move traffic off a bad channel? | `platform-infra`, full stack |

Never test the same thing at two layers. A slow test that repeats a fast test
is waste.

## How to start the stack

```bash
docker compose up -d
npm run wait-for-healthy
npm run seed
npm run e2e
```

`wait-for-healthy` polls `/health` on both services. Do not use a fixed sleep.
A fixed sleep is slow when the machine is fast and it fails when the machine
is slow.

Each service reports `ready` only when Postgres answers, Redis answers, and
the migrations are complete. A service that answers `/health` before the
migrations complete makes the first scenario fail at random.

## Reset between scenarios

Every scenario starts from a known state. Call the reset helper in
`beforeEach`.

The reset does four things in this order:

1. Stop the load generator.
2. Truncate the disbursement tables.
3. Delete every `sw:*` and `breaker:*` key in Redis, and trim the outcome
   stream.
4. Seed the three channels with the default cost and a `CLOSED` breaker.

Do not drop the database between scenarios. A drop forces a migration again
and it adds many seconds to each test.

## Control the clock, not the wall

The window holds 60 seconds. A test that waits 60 seconds of real time is a
bad test.

Use the time control endpoint in the switch service. The endpoint is available
only when `NODE_ENV` is `test`.

```
POST /internal/clock  { "advanceMs": 30000 }
```

The switch reads the time from a clock port. In test mode the port is an
offset clock. This lets a scenario move 5 minutes forward in one millisecond.

Never add a test-only branch inside the routing logic. Inject the clock at the
edge.

## Drive load through the real interface

The load generator calls `POST /transactions` on the disbursement service over
HTTP. It does not call an internal function. A test that skips the HTTP layer
does not test the system.

Control the rate. 20 payouts per second is enough to fill the window. A burst
of 5000 payouts tests the machine, not the routing.

## The scenarios that must exist

| Scenario | Assertion |
|----------|-----------|
| Happy path | Every payout gets a channel, a rail result, and one outcome event |
| Traffic shift | RAIL-B fails 80 percent. Its traffic share falls below 10 percent inside 30 seconds of window time |
| Breaker opens | RAIL-B keeps failing. The breaker reports `OPEN` and RAIL-B gets zero payouts |
| Breaker recovers | RAIL-B heals. The state goes `HALF_OPEN`, then `CLOSED`, and traffic returns |
| Half-open single flight | In `HALF_OPEN`, a burst of 50 payouts sends at most one probe to RAIL-B |
| Cold start | A new channel receives traffic within 60 seconds of window time |
| Redis is down | Payouts still succeed. The switch falls back and marks the reason |
| Switch is down | The disbursement service uses the fallback channel and does not lose the payout |
| Duplicate reference | The same reference twice creates one payout, not two |
| Outcome replay | The same outcome event twice moves the counters once |

The last two scenarios protect money. Keep them first in the file and never
skip them.

## How to assert a traffic shift

Do not assert an exact count. Load is random and an exact count is flaky.

Assert a direction and a bound:

```
share(RAIL-B) before degrade  >  0.25
share(RAIL-B) after  degrade  <  0.10
```

Take the "after" sample from payouts that started after the degrade, not from
all payouts. Mixed samples hide the shift.

## Wait for a condition, never for a duration

Use a poll helper with a timeout and a clear failure message.

```
await waitFor(() => breakerState("RAIL-B") === "OPEN",
  { timeoutMs: 10_000, message: "RAIL-B breaker did not open" })
```

A failure message that names the expected state saves an hour of reading logs.

## When a scenario fails

Print the state before you guess. The harness has a dump helper. It prints:

- The last 20 routing decisions with the full candidate list.
- The window counters for each channel.
- The breaker state for each channel.
- The length of the outcome stream and the pending count of the consumer group.

A pending count that grows means the switch consumer stopped. That is the most
common cause of a stuck scenario.

## Do not put a contract assertion in an e2e test

If an e2e test fails because a field is missing, the pact test was too weak.
Repair the pact test. Do not add a field check to the scenario. An e2e test
that also checks shape becomes slow and it duplicates the broker.

# platform-infra

Shared infrastructure and the end-to-end scenarios. **This is not a service.**
It has no deploy and no runtime.

It exists because two things belong to nobody:

- The Pact Broker, Postgres and Redis, which both services use.
- The scenarios that drive both services at the same time. Neither service
  repository may know about the other, so the scenarios live here.

## The three repositories

```
pact/
  disbursement-service/   sends payouts, asks the switch, produces the outcome event
  switch-service/         selects a channel, reads the outcome event, serves the console
  platform-infra/         this repository
```

Each one is a separate git repository. They share no code. They share only
contracts, and the broker holds the contracts.

## Start the infrastructure

```bash
docker compose up -d
npm run wait-for-infra
```

| Service | Address | Notes |
|---------|---------|-------|
| Postgres | `localhost:5434` | user `pact`, password `pact` |
| Redis | `localhost:6380` | database 0 demo, 1 pact, 2 end-to-end |
| Pact Broker | http://localhost:9292 | user `pact`, password `pact` |

The ports are not the usual ones. A payments laptop already runs Postgres on
5432 and Redis on 6379, and a clash there is hard to see.

`init-db/01-databases.sql` makes four databases. Each service owns one, and
each has a separate test database, so a test run never destroys a demo.

## The broker in a real environment

The compose file above runs a broker for local work and for CI. It is NOT the
one to gate deploys against: a broker started inside a pipeline is empty, so
`can-i-deploy` compares each version against nothing and says yes to everything.

For that you need ONE long-lived broker that every pipeline talks to.
`deploy/cloud-run/` deploys it to Cloud Run with Cloud SQL behind it, for about
10 to 15 US dollars each month:

```bash
export GCP_PROJECT=<your-project-id>
cd deploy/cloud-run && ./deploy.sh
```

Read `deploy/cloud-run/DEPLOY.md` first. It explains why read is authenticated
there and public here, and why Cloud Run IAM is deliberately off.

## Set up the broker

```bash
npm run webhooks
```

This makes the `local` environment, which `can-i-deploy` needs. It also makes
the verification webhooks when `WEBHOOK_URL` is set. Without a webhook, a
consumer change stays silent until the next provider build.

## Run the scenarios

Build both services first. The harness starts the BUILT service, not the
sources.

```bash
cd ../disbursement-service && npm run build
cd ../switch-service && npm run build
cd ../platform-infra && npm run e2e
```

The harness starts both services on ports 4020 and 4021, against the test
databases and Redis database 2. It stops them at the end.

| Variable | Meaning |
|----------|---------|
| `E2E_CHAOS=true` | Also run the scenario that stops Redis |
| `E2E_USE_RUNNING_SERVICES=true` | Test what is already running, start nothing |
| `E2E_LOG_LEVEL=info` | More detail in `logs/` |

The harness refuses to start when a port is already busy. That check exists
because a service left over from an earlier run answers the health poll, and
the whole run then tests the old build without saying so.

## Verify it yourself

Six checks, in order. Each one takes a minute or less.

### 1. Everything is green

```bash
cd ../disbursement-service && npm run typecheck && npm test
cd ../switch-service      && npm run typecheck && npm test
cd ../platform-infra      && npm run e2e
```

Expect 161 unit tests, 25 integration tests, 6 contract tests and 17
scenarios.

### 2. One payout goes end to end

```bash
curl -X POST localhost:4010/transactions \
  -H 'content-type: application/json' \
  -d '{"reference":"CHECK-1","amountMinor":250000,"currency":"NGN",
       "bankCode":"058","accountNumber":"0123456789"}'
```

Look for `"routingSource":"switch"`. A value of `fallback` means the switch did
not answer, and the routing proved nothing.

### 3. The outcome reached the switch

```bash
curl -s localhost:4011/channels
```

The channel that took the payout now shows `success: 1`. That number came back
over Redis, so the whole loop works.

### 4. The switch moves traffic away from a bad rail

Open http://localhost:4011/console/, press **start load**, then **degrade** a
rail to 85 percent failure.

Its share falls to a few percent inside about 25 seconds. The few percent that
remain are exploration, on purpose: without them a repaired channel could never
prove that it is healthy again.

Keep it broken and the breaker goes `OPEN`. Repair it and watch
`HALF_OPEN`, then `CLOSED`.

### 5. A payout cannot double

```bash
curl -X POST localhost:4010/transactions -H 'content-type: application/json' \
  -d '{"reference":"SAME","amountMinor":100,"currency":"NGN",
       "bankCode":"058","accountNumber":"0123456789"}'
# run the same command again
```

The second call answers 200 with `"replayed":true`, and there is still one
payout.

### 6. Break a contract on purpose

This is the check that proves the contract testing is real. Everything else
proves the code works today.

In `switch-service/src/controllers/routing.controller.ts`, rename one field
of the response:

```diff
-        strategy: decision.strategy,
+        routingStrategy: decision.strategy,
```

Then:

```bash
cd switch-service
npm run test:unit        # 101 tests still PASS. Unit tests cannot see this.
npm run pact:provider    # FAILS: "Actual map is missing the following keys: strategy"
npm run pact:can-i-deploy   # answers NO, and exits 1, so the deploy is blocked
```

Put the field back and both go green again.

The same proof runs automatically on every push, in
`.github/workflows/contract-validation.yml`. That job FAILS if the gate stays
green after the break, because a pipeline that only ever goes green tells you
nothing about whether the check does anything.

**That is the whole value of the system.** A rename that every unit test
accepts is caught before it reaches production, in a different repository from
the one that made the change.

## What each test layer proves

| Layer | Question | Where |
|-------|----------|-------|
| Unit | Is the maths right? | Each service, no docker |
| Contract | Do the services agree on the wire? | Each service, plus the broker |
| Integration | Does the code talk to Redis and Postgres? | Each service, with docker |
| End to end | Does the switch move traffic off a bad channel? | Here |

Never test the same thing at two layers. A slow test that repeats a fast test
is waste.

## The scenarios

`01-money` runs first and nobody skips it.

| File | Proves |
|------|--------|
| `01-money` | One payout for one reference. No outcome is lost. A repeated event counts once. |
| `02-routing` | Traffic moves off a bad channel. The breaker opens, probes once, and closes again. |
| `03-resilience` | The money path never waits for the metrics path. Redis can go away. |

## When a scenario fails

The failure message prints the state: the window of each channel, the breaker
of each channel, the length of the outcome stream, and the pending count of
the consumer group.

**A pending count that grows means the switch consumer stopped.** That is the
most common cause of a stuck scenario.

The service output is in `logs/`.

## Stop everything

```bash
docker compose down        # keep the data
docker compose down -v     # remove the data as well
```

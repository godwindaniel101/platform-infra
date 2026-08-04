---
name: pact-contract-testing
description: House rules for consumer-driven contract tests between the two independent service repositories. Use this skill when you add, change or debug a Pact test, a provider state, a message pact, a broker publication or a can-i-deploy gate. Trigger on "pact", "contract test", "provider state", "consumer test", "pact broker", "can-i-deploy", "message pact", or when you change an HTTP payload or a Redis event payload that crosses a service boundary.
---

# Pact contract tests across separate repositories

Each service lives in its own git repository. The repositories do not share
code. They share only contracts, and the broker holds the contracts.

## The repositories

| Repository | Role |
|------------|------|
| `disbursement-service` | Sends payouts through the internal rails. Consumer of the switch. Producer of the outcome event. |
| `switch-service` | Selects a channel. Provider to the disbursement service. Consumer of the outcome event. |
| `platform-infra` | Runs Redis, Postgres and the Pact Broker. Holds the end-to-end tests. Not a service. |

## The two contract pairs

| Pair | Consumer repository | Provider repository | Type |
|------|--------------------|--------------------|------|
| 1 | `disbursement-service` | `switch-service` | HTTP |
| 2 | `switch-service` | `disbursement-service` | Message |

In pair 2 the switch reads the outcome event. Therefore the switch is the
consumer. The disbursement service sends the event. Therefore it is the
provider. The direction of the contract follows the data, not the call.

Note that each service is a consumer in one pair and a provider in the other
pair. Both repositories run both kinds of test.

## Rule 1: do not share types between the repositories

Each repository declares its own types for the wire. The disbursement service
has its own `RouteResponse` type. The switch service has a different
declaration of the same response. This duplication is correct.

Do not make a shared npm package for the contract types. A shared package
hides a break. Both sides change together and the pact still passes. Then the
deployed services disagree. The duplication is the test.

## Rule 2: do not change the wire to make a test pass

A contract test protects the wire. If a test fails, one of two things is true:

1. The provider broke the contract. Repair the provider.
2. The consumer needs a new field. Change the consumer test first. Publish the
   pact. Then change the provider. Then verify.

Never delete an expectation to get a green build.

## Rule 3: pact files move only through the broker

Do not copy a pact file from one repository to the other. Do not commit a pact
file from a different repository. The broker is the only exchange.

```
consumer repo  --publish-->  broker  --verify-->  provider repo
```

The broker runs at `http://localhost:9292` in local work. Start it from the
`platform-infra` repository:

```bash
docker compose up -d pact-broker
```

## Where the files are in each repository

```
test/pact/*.consumer.pact.test.ts    consumer tests
test/pact/*.provider.pact.test.ts    provider verification
pacts/                               generated pact files, git ignored
logs/                                pact tool logs, git ignored
```

Add `pacts/` and `logs/` to `.gitignore` in both repositories. A tool writes
these files. A person does not edit them.

## How to write a consumer test

1. Use a matcher for each value that changes. Use `like`, `eachLike`,
   `integer`, `decimal`, `iso8601DateTimeWithMillis` and `regex`.
2. Use an exact value only when the value is part of the contract. A status
   string such as `"success"` is part of the contract. A score is not.
3. Give the interaction a clear description, such as
   `a request to route a NGN payout`.
4. Give the interaction a provider state, such as `channel RAIL-A is healthy`.
5. Assert on the client function, not on the raw HTTP response. The test must
   prove that the client can read the response.

A contract test is not a data test. Do not assert that the score is `0.94`.
Assert that the score is a decimal. A tight matcher makes the provider test
fail for no good reason.

## How to write a provider state

A provider state puts the provider into a known condition. Each state is small
and independent.

1. Add the handler in the `stateHandlers` map of the provider test.
2. Clear the database and Redis at the start of the handler. Then seed only
   what the state needs.
3. Never let one state depend on a different state.
4. Add a teardown when the state writes to Redis or to Postgres.

States for the `switch-service` provider:

- `channels exist and RAIL-A is healthy`
- `all channels are open with equal health`
- `RAIL-C breaker is open`
- `no channels are configured`

## How to write a message pact

The message pact tests the Redis stream payload. It does not test Redis.

1. In `switch-service`, the consumer test builds the expected message with
   `MessageConsumerPact`.
2. The consumer test passes the message to the real handler function. The
   handler accepts a plain object. Do not pass a Redis client into the handler.
3. In `disbursement-service`, the provider test registers a `messageProviders`
   entry. The entry calls the real producer function. The producer returns the
   event object.
4. Keep the producer pure. One function builds the event. A different function
   writes the event to Redis.

This split is the reason the message pact works. Keep the split.

## Versions, branches and environments

Every publication carries three values.

| Value | Source | Example |
|-------|--------|---------|
| Consumer or provider version | Git commit SHA | `a1b2c3d` |
| Branch | Git branch | `main` |
| Environment | The deploy target | `local`, `production` |

Set these values from the environment. Do not write a version in the code.

```bash
export PACT_BROKER_BASE_URL=http://localhost:9292
export PACT_BROKER_USERNAME=pact
export PACT_BROKER_PASSWORD=pact
export GIT_COMMIT=$(git rev-parse --short HEAD)
export GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

A dirty tree gets a `-dirty` suffix on the version. Commit your work before you
publish.

## The provider verifies against the broker, not against a file

The provider test uses consumer version selectors. The selectors tell the
broker which pacts to verify.

```ts
consumerVersionSelectors: [
  { mainBranch: true },        // the contract on main
  { deployed: true },          // every contract now in an environment
  { matchingBranch: true },    // the contract on the same branch name
]
```

Always set `publishVerificationResult` to true in continuous integration. The
broker cannot answer `can-i-deploy` without the result.

## The deploy gate

`can-i-deploy` must pass before any merge and before any deploy. The command
asks the broker one question: does the other service agree with this version?

```bash
npm run pact:can-i-deploy
```

Run the gate in each repository. A green gate in one repository says nothing
about the other repository.

## Broker webhooks

The broker calls a webhook when a consumer publishes a new pact. The webhook
starts the provider verification. Without the webhook, a consumer change is
silent until the next provider build.

Set up the webhooks once, from the `platform-infra` repository:

```bash
./scripts/create-webhooks.sh
```

## Order of work for a contract change

Follow this order. A different order breaks the deployed system.

1. Add the field to the consumer test as optional. Publish the pact.
2. Add the field to the provider. Verify. Deploy the provider.
3. Make the field required in the consumer. Publish. Verify.
4. Deploy the consumer.

To remove a field, reverse the order. Remove the use in the consumer first.

## Common failures and the cause

| Symptom | Cause | Repair |
|---------|-------|--------|
| Provider verification fails on one field | The provider stopped sending the field | Put the field back |
| Provider verification fails on all interactions | The provider did not start | Read the provider log |
| `can-i-deploy` reports unknown | Nobody published a pact for that version | Publish the pact |
| Consumer test passes and provider test fails | The matcher was too tight | Loosen the matcher, not the provider |
| Message pact fails on a date | The producer used a different date format | Use ISO 8601 with milliseconds |
| Provider test hangs | A provider state waits for a database | Check the database connection |

## What a contract test does not do

- It does not test business logic. Use a unit test.
- It does not test Redis, Postgres or the network. Use an integration test.
- It does not test the full flow. Use the e2e harness.

Keep each layer in its own place.

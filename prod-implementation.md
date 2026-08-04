# Integration-test plan: disbursement ↔ switching

`fincra-disbursements` ↔ `fincra-switching-engine` / dyna-switch

Scope is these two systems only. The `fincra-integrations` gateway is out of
scope and is not mentioned again.

Written against `main` of both repositories on 2026-08-04, from source. Nothing
was run. Statements that are judgement rather than read from the code say so.

---

## 1. The finding that should drive this

`fincra-disbursements` and the switch **already have a cross-repo contract.** It
is a JSON file, copied by hand between the two repositories.

`src/components/disbursements/payouts/services/__tests__/fixtures/cross-repo-vectors.golden.json`

```jsonc
{
  "schemaVersion": 1,
  "generatedFrom": "dyna-switch",
  "constants": {
    "signatureSchemeVersion": "v1",
    "domainSeparators": { "serviceRequest": "dyna-switch:v2:service-request" },
    "decisionStatuses": ["active", "claimed", "closed", "expired"],
    "noRouteReasonCodes": ["NO_ELIGIBLE_PROVIDER", "NO_POSITIVE_WEIGHT", …]
  },
  "vectors": { "hmac": [ … ], "decisionIdentity": [ … ] }
}
```

It is read by `crossRepoGoldenVectors.gate.spec.ts`, whose own comment states the
model exactly:

> *Generated from dyna-switch, the authoritative side of the contract. Any
> mismatch here means this mirror is wrong, never the fixture.*

This is a real attempt at the right problem, and whoever built it was thinking
clearly: signature vectors, domain separators, a released constant set, a
schema version. **The mechanism is what needs replacing, not the intent.**

### Four things this cannot do

1. **Staleness is undetectable.** The fixture is a copy. If dyna-switch changes
   its signature scheme and nobody regenerates the file, every disbursements test
   still passes — against last month's contract. Green while broken.
2. **The direction is backwards.** "The authoritative side" is the provider, and
   disbursements is a "mirror". A consumer-driven contract inverts this: the
   consumer states what it needs, and **the provider's build fails** if it stops
   meeting it. Today disbursements has no way to make that happen.
3. **There is no deploy gate.** Nothing stops the switch shipping a change that
   breaks disbursements. The fixture is checked after the fact, in one repo only.
4. **The authoritative generator could not be located.** `generatedFrom` names
   `dyna-switch`, but an org-wide code search for `route-decisions` and
   `attempt-outcome-events` returns hits **only inside `fincra-disbursements`**,
   and `fincra-switching-engine` contains no HMAC code at all. Either that
   service lives somewhere this account cannot see, or it is not built yet.
   Both readings make the copied fixture harder to trust, not easier.

**A Pact Broker replaces the copied file with an exchange neither side owns.**
That is the whole proposal. Everything below is how to get there.

---

## 2. The three boundaries

### A. `POST /v2/route` — synchronous, live money

| | |
|---|---|
| Caller | `payouts/repos/PayoutsUtilRepository.ts:1109` |
| Base URL | `SWITCHING_ENGINE_SERVICE_BASE_URL` |
| Provider | `fincra-switching-engine` |
| Auth | `SERVICE_SECRET_KEY` (per `switchV2/monitor/simulator.ts:18`) |

`switchEventsConsumer.ts` calls this "Stage 1" and notes it "stays synchronous
HTTP" while stages 2 and 3 moved to a queue.

### B. SQS events — asynchronous, live

| | |
|---|---|
| Producer | `payouts/repos/switchEventsProducer.ts` (disbursements) |
| Consumer | `switchV2/events/switchEventsConsumer.ts` (switch) |
| Queue | `SWITCH_ROUTER_EVENTS_QUEUE_URL` |

Already a typed discriminated union:

```ts
export type SwitchEventMessage =
  | { type: "channel-event";
      providerKey: string; transactionId: string;
      event: "accepted" | "rejected";
      rejectedType?: "timeout" | "infra-failure" | "business-failure";
      latencyMs: number }
  | { type: "transaction-outcome";
      providerKey: string; transactionId: string;
      status: "success" | "failed" };
```

The consumer's comment says validation, idempotency and recording "all live
there" — so the switch already treats this as a boundary with rules.

### C. dyna-switch — synchronous, HMAC, shadow

```
POST {DYNA_SWITCH_SERVICE_BASE_URL}/api/route-decisions
POST {DYNA_SWITCH_SERVICE_BASE_URL}/api/attempt-outcome-events
```

| Client | File |
|---|---|
| Route decision | `payouts/services/dynaRouteClient.ts` |
| Attempt outcome | `payouts/services/dynaAttemptOutcomeClient.ts` |
| Decision lifecycle | `payouts/services/dynaDecisionLifecycleClient.ts` |

The paths are exported constants, and the stated reason matters:

> *The exact bytes used in the URL and HMAC canonical request. Exported so the
> cross-contract gate cannot accidentally freeze a different versioned path.*
> — `dynaRouteClient.ts:13`

HMAC is mandatory in production:

```ts
if (production && configured !== "hmac") {
  throw new Error("Dyna HMAC authentication is required in production");
}
```

And this path does not carry money yet. `dynaAuthorityContracts.ts` freezes it:

```ts
export const DYNA_RELEASE_CAPABILITY = Object.freeze({
  routing: "shadow_only",
  profileResolution: "evidence_only",
  decisionLifecycle: "dormant",
  attemptOutcome: "dormant",
  authority: false,
});
```

---

## 3. What to test, in order

Not everything. Contract-test what breaks money when it drifts.

| # | Interaction | Type | Why in this position |
|---|---|---|---|
| 1 | `transaction-outcome` on SQS | Message | Typed union, small producer, no HMAC, no running provider needed |
| 2 | `channel-event` on SQS | Message | Same producer, near-zero extra cost |
| 3 | `/api/route-decisions` | HTTP | **Replaces the copied golden fixture.** Shadow mode, so a mistake costs nothing |
| 4 | `/api/attempt-outcome-events` | HTTP | Completes the dyna loop |
| 5 | `POST /v2/route` | HTTP | **Live money. Last, once the pattern is boring.** |

Excluded for now: `dynaDecisionLifecycleClient` (dormant), and every read whose
response no money-path decision consumes.

---

## 4. The plan

Four stages, each shippable alone.

### Stage 1 — Broker, and the SQS outcome message pact

Start here, not with HTTP. The type is already a union, the producer is one small
file, and a message pact needs no running provider and no HMAC.

**The switch is the consumer**, because it reads the event. The direction of a
contract follows the data, not the call. Disbursements is the provider even
though it does the sending. Getting this backwards is the most common first
mistake.

```ts
// in fincra-switching-engine, in its own vitest lane
.given("a payout succeeded on providerKey providus")
.expectsToReceive("a transaction outcome")
.withContent({
  type: string("transaction-outcome"),   // exact: it selects the handler
  providerKey: like("providus"),
  transactionId: like("…"),
  status: regex(/^(success|failed)$/, "success"),
})
```

One prerequisite in disbursements: **the message must be built by a function that
does not send it.** If `switchEventsProducer` builds and calls SQS in one
function, split it — a ten-line change. Without the split the message pact needs
a real queue, and the whole advantage is lost.

Broker: `platform-infra/deploy/cloud-run/`, already proven against a live GCP
project. One shared broker for every service, never one per pair.

Effort: judgement, three to four days including the broker and first-time
learning.

### Stage 2 — Retire the golden fixture

Turn `cross-repo-vectors.golden.json` into a published contract.

The migration is deliberately conservative:

1. Write the consumer pact for `/api/route-decisions` from the **existing golden
   vectors**. They already encode the request shape, the signature scheme and
   the released constants. Do not invent new expectations.
2. Publish it to the broker from the disbursements build.
3. **Keep `crossRepoGoldenVectors.gate.spec.ts` running.** For one release both
   mechanisms run side by side. If they disagree, the fixture is right and the
   pact is wrong — that is what "conservative" means here.
4. When dyna-switch verifies the published pact and the results agree for a
   release, delete the fixture and its gate spec.

Two HMAC specifics, because this is the one genuinely new problem:

- **Match the signature header by type, never by value.** Its value is derived
  from the body bytes, and pact matchers deliberately vary those. Assert the
  header is *present* and is a string.
- **Provider verification must run with `DYNA_SWITCH_AUTH_MODE=hmac` and a test
  key**, with the same key given to the consumer test. Do not verify in `bearer`
  mode: the production guard exists precisely because the modes differ, and
  verifying a mode production never uses proves very little.

Import `DYNA_ROUTE_DECISIONS_PATH` into the pact rather than retyping the
string. That is what the "cross-contract gate" comment was anticipating.

Effort: judgement, four days. Longer than stage 1 because of HMAC and because
two mechanisms run together.

### Stage 3 — Gate on, warn mode first

Add `contract-gate` to `test.yml` in both repositories. **For the first two weeks
it must not fail the build.** Then make the deploy workflows (`dev.yml`,
`sandbox.yml`, `tag.yaml`) depend on it. That dependency is the entire mechanism;
without it the gate is a report.

Both required, neither optional:

- **`enablePending: true`**, so a new expectation cannot break a provider that
  has never seen it. Consequence to know: a contract nobody has verified reports
  failures but does not fail the build, and becomes fatal only after the first
  successful verification.
- **A broker webhook**, so a consumer change triggers the provider build. Without
  it `can-i-deploy` answers "unknown" for ever and somebody removes the gate.

Effort: two days, then two weeks of watching.

### Stage 4 — `/v2/route`, the live path

Only when stages 1 to 3 are boring. This one carries real payouts today.

Put in the contract **only the fields a payout consumes** — the provider key and
the decision. A contract that lists everything the switch returns will break a
build every time the switch adds a field nobody reads.

`PayoutsUtilRepository.ts` is large; expect the response to be read in more
places than a first reading suggests. Most of this stage is reading, not writing.

Effort: judgement, one week.

---

## 5. Reuse, do not rebuild

| Asset | Where | Use for |
|---|---|---|
| `*.gate.spec.ts` vitest lane, 58 specs | `fincra-disbursements/vitest.config.ts` | The lane pact specs join |
| 21 `dyna*.gate.spec.ts` | `payouts/services/__tests__/` | Conventions to copy |
| `cross-repo-vectors.golden.json` | same `__tests__/fixtures/` | **The source of the first pact's expectations** |
| Exported path constants | `dynaRouteClient.ts` | Import into the pact, never retype |
| `DYNA_RELEASE_CAPABILITY` | `dynaAuthorityContracts.ts` | The shadow guard already exists |
| `switchEventsConsumer.ts` | `fincra-switching-engine` | Where the message pact's handler lives |
| `test.yml`, both repos | `.github/workflows/` | Where the gate hooks in |
| Both repos run vitest | both `package.json` | One test runner, no new tooling |

Both services are Express and TypeScript, both already run vitest, and both
already have a gate-spec convention. **No new tooling is needed beyond
`@pact-foundation/pact`.**

---

## 6. Things that will bite

Each of these was met while proving the mechanism end to end on a real broker.
Every one fails with a message that points somewhere else.

| Symptom | Cause |
|---|---|
| `No pacts found matching the given consumer version selectors`, contracts all present | The pacticipant's `mainBranch` is unset. `PUT /pacticipants` replaces the record and erases it. `POST` to create, `PATCH` to amend. |
| `can-i-deploy` says YES for a version nobody published | An empty matrix reports `deployable: true` — nothing is missing when nothing is expected. Treat zero rows as a failure. |
| `can-i-deploy` against an environment can never pass | Nothing is recorded as deployed there, and only a deploy records it. Fall back to the main-branch comparison until the first record exists. |
| `record-deployment` 404 "document not found" | That endpoint takes the environment **UUID**, not its name. Read `pb:record-deployment` off the version resource. |
| The gate fails slowly and blames the wrong thing | A retry loop re-asking a different question than the one it fell back to. |
| A verification fails but does not fail the build | The contract is still pending. Pending ends after the first successful verification. |
| A break test blocks every other service | It ran against the shared broker. Run it against a broker started inside the pipeline. |
| The HMAC signature never matches | A pact matcher varied the body after the signature was computed. Match the header by type. |
| A dirty tree gives a version nobody published | The version is the git commit plus a `-dirty` suffix. Check `git status` before blaming the gate. |

---

## 7. What this will not do

- **It does not test routing quality.** Whether the switch picks a good provider
  is an end-to-end question, not a contract one.
- **It does not replace the 58 gate specs.** They test invariants no contract
  test can see.
- **It does not make HMAC correct in production.** A contract proves the shape
  crosses; it does not prove the signing key is right in the live environment.
- **It does not remove the need for the switch provider to exist.** If
  dyna-switch is not built yet, a published consumer contract is a *specification
  for it* — which is more useful than a fixture, but still not a running service.

---

## 8. Order and effort

Effort is judgement from reading the code, not measurement.

| Stage | Work | Rough effort | Value if you stop here |
|---|---|---|---|
| 1 | Broker + `transaction-outcome` message pact | 3–4 days | The event the switch learns from is pinned, both directions |
| 2 | `/api/route-decisions`, retire the golden fixture | 4 days | The copied file stops being the contract |
| 3 | Gate in warn mode, then blocking | 2 days + 2 weeks | Drift becomes visible, then blocked |
| 4 | `/v2/route`, live money | 1 week | The live path is covered |

---

## 9. The two time-sensitive points

**Do stage 2 before `DYNA_RELEASE_CAPABILITY.authority` becomes `true`.** While
the path is `shadow_only` a contract costs nothing to get wrong, and it defines
the wire *before* the switch is given authority over money. Afterwards, the same
work is archaeology on a live path.

**Do stage 1 before the golden fixture is regenerated again.** Every regeneration
is a manual copy between repositories, and each one is a chance to be silently a
release behind.

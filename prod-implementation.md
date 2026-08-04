# Integration-test plan for the switch-engine path

`fincra-disbursements` ↔ `fincra-switching-engine` (V2 and DYNA)

Written against `main` of both repositories on 2026-08-04, from source. Nothing
was run. Where a statement is judgement rather than something read from the
code, it says so.

---

## 0. Correction to the first version of this document

The first version planned the **`fincra-disbursements` ↔ `fincra-integrations`**
boundary: the `POST /integration/gateway` action-dispatch endpoint. That is a
real boundary and section 7 keeps the findings, but it is **not the switch-engine
path** and it was the wrong target for this goal.

The switch-engine path is the one that mirrors the proof of concept almost
exactly, and it is a considerably better first target. Section 2 says why.

---

## 1. The three boundaries

Disbursements talks to the switching engine in three separate ways. Each needs a
different kind of test.

### A. Synchronous route, V2 (live)

```
POST {SWITCHING_ENGINE_SERVICE_BASE_URL}/v2/route
```

`src/components/disbursements/payouts/repos/PayoutsUtilRepository.ts:1109`

The comment in `switchEventsProducer.ts` calls this "Stage 1", and says it "stays
synchronous HTTP" while stages 2 and 3 moved to a queue.

### B. Synchronous DYNA, HMAC-signed (shadow)

```
POST {DYNA_SWITCH_SERVICE_BASE_URL}/api/route-decisions
POST {DYNA_SWITCH_SERVICE_BASE_URL}/api/attempt-outcome-events
```

| Client | File |
|---|---|
| Route decision | `payouts/services/dynaRouteClient.ts` |
| Attempt outcome | `payouts/services/dynaAttemptOutcomeClient.ts` |
| Decision lifecycle | `payouts/services/dynaDecisionLifecycleClient.ts` |

The paths are already exported as constants, and the reason given in
`dynaRouteClient.ts:13` is worth quoting:

> *The exact bytes used in the URL and HMAC canonical request. Exported so the
> cross-contract gate cannot accidentally freeze a different versioned path.*

**Somebody has already designed for a cross-contract gate.** This plan is
finishing a thought that repository started, not introducing a new one.

Authentication is HMAC over method, path and a SHA-256 of the body, and
production refuses anything else:

```ts
if (production && configured !== "hmac") {
  throw new Error("Dyna HMAC authentication is required in production");
}
```

### C. Asynchronous events over SQS (live)

Queue: `SWITCH_ROUTER_EVENTS_QUEUE_URL`
Producer: `payouts/repos/switchEventsProducer.ts`

The message is already a typed discriminated union:

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

The file's own comment states the consumer: *"The switch drains this queue
in-process and feeds its existing record handlers."*

---

## 2. Why this path, and not the integrations gateway

The integrations gateway needed a refactor before a single contract test could be
written: five scattered `axios.post` calls, `data: any`, no client. The
switch-engine path needs none of that.

| Needed | Integrations gateway | Switch-engine path |
|---|---|---|
| A typed client to test | **absent** — must be built first | **present** — three of them |
| A stable, versioned path | none, dispatch is in the body | `/v2/route`, `/api/route-decisions` |
| A typed payload | `data: any` | `DynaRouteDecisionV2`, `SwitchEventMessage` |
| An established test lane | `*.gate.spec.ts` exists | same, plus 21 dyna gate specs |
| Carrying money today | yes | **`/v2/route` yes, DYNA no** |

The last row is the strongest argument, and it is time-limited.

`payouts/services/dynaAuthorityContracts.ts` freezes the current release as:

```ts
export const DYNA_RELEASE_CAPABILITY = Object.freeze({
  routing: "shadow_only",
  profileResolution: "evidence_only",
  decisionLifecycle: "dormant",
  attemptOutcome: "dormant",
  authority: false,
});
```

**DYNA is in shadow mode. It does not yet carry money.** Contract tests written
now become the definition of the wire *before* the switch is given authority.
Written later, they document whatever the two services drifted into. This window
closes when `authority` becomes `true`.

### The proof of concept maps onto this almost exactly

| Proof of concept | Switch-engine path |
|---|---|
| `POST /route`, disbursement to switch | `POST /v2/route`, `POST /api/route-decisions` |
| Outcome over a Redis stream | `transaction-outcome` over SQS |
| Transactional outbox for the outcome | the dyna route outbox (`dynaRouteOutboxPolicy`) |
| Switch keeps a sliding window | the switch's own record handlers |
| HTTP pact plus one message pact | the same two shapes, times three boundaries |

Both pact pairs built in the proof of concept transfer directly. The synchronous
route is an HTTP pact; the SQS event is a message pact.

---

## 3. What to contract-test, in order

Not everything. Contract-test what breaks money when it drifts.

| # | Interaction | Type | Why first |
|---|---|---|---|
| 1 | `POST /api/route-decisions` | HTTP | Typed client exists, shadow mode, zero risk |
| 2 | `transaction-outcome` on SQS | Message | Two words wrong here and the switch learns a lie |
| 3 | `channel-event` on SQS | Message | Same producer, near-zero extra cost |
| 4 | `POST /api/attempt-outcome-events` | HTTP | Completes the DYNA loop |
| 5 | `POST /v2/route` | HTTP | **Live money. Do this last, after the pattern is proven.** |

Deliberately excluded for now: `dynaDecisionLifecycleClient` (dormant), and every
read that no money-path decision consumes.

---

## 4. The plan

Four stages. Each is shippable alone.

### Stage 1 — Broker, and one message pact

Start with the **SQS `transaction-outcome` event**, not the HTTP route. Three
reasons: the type is already a discriminated union, the producer is one small
file, and a message pact needs no running provider and no HMAC.

Consumer side is `fincra-switching-engine` — **the switch is the consumer of the
event, because it reads it.** The direction of a contract follows the data, not
the call. Disbursements is the provider even though it does the sending.

```ts
// in fincra-switching-engine, joining its own test lane
.given("a payout succeeded on providerKey X")
.expectsToReceive("a transaction outcome")
.withContent({
  type: string("transaction-outcome"),      // exact: it selects the handler
  providerKey: like("providus"),
  transactionId: like("..."),
  status: regex(/^(success|failed)$/, "success"),
})
```

Provider side in disbursements calls the real producer. Keep the message
**building** separate from the **sending**, exactly as `buildOutcomeEvent` was
kept separate from the Redis write in the proof of concept. If
`switchEventsProducer` builds and sends in one function, split it first — that is
a ten-line change, and without it the message pact needs SQS.

Broker: `platform-infra/deploy/cloud-run/`, already proven. One shared broker for
all seventeen services.

Effort: judgement, three to four days including the broker and the first-time
learning.

### Stage 2 — The DYNA route decision, with HMAC

The one genuinely new problem in this plan.

The request carries a signature over method, path and a SHA-256 of the body. Two
consequences:

1. **In the consumer pact, match the signature header by type, never by value.**
   Its value depends on the body bytes, which pact matchers deliberately vary.
   `Authorization: like("...")`, and assert the *presence* of the header.
2. **In the provider verification, HMAC must be satisfiable.** Run the provider
   with `DYNA_SWITCH_AUTH_MODE=hmac` and a **test key pair**, and give the
   consumer test the same key so it signs what the provider will accept. Do not
   set `bearer` for the test: the production guard exists precisely because the
   modes differ, and verifying the mode production does not use proves little.

The paths are already constants (`DYNA_ROUTE_DECISIONS_PATH`), so the pact should
import them rather than repeat the string. That is what the comment about the
"cross-contract gate" was anticipating.

Effort: judgement, three days, most of it on the HMAC fixture.

### Stage 3 — Gate on, warn mode first

Add `contract-gate` to `test.yml` in both repositories, and **do not let it fail
the build for the first two weeks.** Then make `dev.yml`, `sandbox.yml` and
`tag.yaml` depend on it. That dependency is the whole mechanism.

`enablePending: true` and a broker webhook are both required. Without the
webhook, a consumer change never triggers the provider build, `can-i-deploy`
answers "unknown" forever, and someone removes the gate.

Effort: two days, then two weeks of watching.

### Stage 4 — `/v2/route`, the live money path

Only after stages 1 to 3 are boring. `/v2/route` carries real payouts today, and
`PayoutsUtilRepository.ts` is a large file; expect the response shape to be read
in more places than a first reading suggests.

Put in the contract only the fields a payout actually consumes — the provider key
and the decision. A contract listing every field the switch happens to return
breaks a build every time the switch adds an unread field.

Effort: judgement, one week, mostly reading.

---

## 5. Reuse, do not rebuild

| Asset | Where | Use for |
|---|---|---|
| `*.gate.spec.ts` lane, vitest, 58 specs | `fincra-disbursements/vitest.config.ts` | The lane pact specs join |
| 21 `dyna*.gate.spec.ts` | `payouts/services/__tests__/` | The conventions to copy |
| Exported path constants | `dynaRouteClient.ts` | Import into the pact, never retype |
| `DYNA_RELEASE_CAPABILITY` | `dynaAuthorityContracts.ts` | The shadow-mode guard already exists |
| `channelMock` | `fincra-integrations` | Provider states, if the gateway is done later |
| `test.yml` | both `.github/workflows/` | Where the gate hooks in |

---

## 6. Things that will bite

Each of these was met while proving the mechanism end to end. Each fails with a
message pointing somewhere else.

| Symptom | Cause |
|---|---|
| `No pacts found matching the given consumer version selectors`, contracts all present | The pacticipant's `mainBranch` is unset. `PUT /pacticipants` replaces the record and erases it. `POST` to create, `PATCH` to amend. |
| `can-i-deploy` says YES for a version nobody published | An empty matrix reports `deployable: true`. Treat zero rows as failure. |
| `can-i-deploy` against an environment can never pass | Nothing is recorded as deployed there, and only a deploy records it. Fall back to the main branch until the first record. |
| `record-deployment` 404 "document not found" | The endpoint takes the environment **UUID**, not its name. |
| The gate fails slowly and blames the wrong thing | A retry loop re-asking a different question than the one it fell back to. |
| A verification fails but does not fail the build | The contract is still pending. Pending ends after the first successful verification. |
| A break test poisons everyone's gate | It ran against the shared broker. Use a broker started inside the pipeline. |
| The signature never matches | The pact matcher varied the body after the signature was computed. Match the header by type. |

---

## 7. The integrations gateway, kept for later

Findings from the first version of this document. A real boundary, worth doing
after the switch-engine path.

- One endpoint: `POST {INTEGRATIONS_SERVICE_BASE_URL}/integration/gateway`, body
  `{ channelName, action, data }`, dispatching on `action`.
- The inbound Joi schema declares `data: Joi.object()`. **The payload that
  carries the money is unvalidated and untyped on both sides.**
- Five call sites, each building its own `axios.post` with `data: any`:
  `disbursementsRepository.ts` 254, 770, 793; `PayoutsUtilRepository.ts` 955;
  `transactionStatusQueryRepository.ts` 20.
- 13 actions, 9 channels. `deccs/gate.ts` already names the money path:
  `disburse`, `gettransactions`, `getdisbursement`. Use that set.
- DECCS appends `mappedError` additively, so a contract must treat it as
  optional.
- **Stage 0 for that path is a client refactor, not a test.** It is worth doing
  regardless: today the timeout fallback is inline at a call site, and the
  "HTTP 200 with the failure in the body" check exists in one call path only.

---

## 8. What this will not do

- It does not test behaviour. Whether the switch picks a good provider is an
  end-to-end question.
- It does not test the partners. Providus changing its API is a different
  problem, which `channelMock` and DECCS already address.
- It does not replace the 58 gate specs, which test invariants no contract test
  can see.
- It does not remove the HMAC risk. A contract test proves the shape crosses; it
  does not prove the signature is right in production.

---

## 9. Order and effort

Effort is judgement from reading the code, not measurement.

| Stage | Work | Rough effort | Value if you stop here |
|---|---|---|---|
| 1 | Broker + `transaction-outcome` message pact | 3–4 days | The event the switch learns from is pinned |
| 2 | `/api/route-decisions` with HMAC | 3 days | The DYNA wire is pinned before it gets authority |
| 3 | Gate in warn mode, then blocking | 2 days + 2 weeks | Drift visible, then blocked |
| 4 | `/v2/route`, live money | 1 week | The live path is covered |

## 10. The one time-sensitive point

**Do stage 2 before `DYNA_RELEASE_CAPABILITY.authority` becomes `true`.**

While DYNA is `shadow_only` a contract test costs nothing to get wrong and
defines the wire before it carries money. After authority is granted, the same
test is archaeology on a live money path. That window is the single best reason
to start now rather than after the next release.

# Contract testing for `fincra-disbursements` ↔ `fincra-integrations`

An implementation plan, written against the code as it stands on `main` on
2026-08-04.

Everything below was read from shallow clones of `FincraNG/fincra-disbursements`
and `FincraNG/fincra-integrations`. Nothing was run. Where a claim is a
judgement rather than something read from the source, it says so.

---

## 1. What the boundary actually is

The two services meet at **one endpoint**:

```
POST {INTEGRATIONS_SERVICE_BASE_URL}/integration/gateway
```

It is not REST. It is an action-dispatch gateway:

```jsonc
// request
{ "channelName": "rave", "action": "getDisbursement", "data": { "reference": "..." } }

// success
{ "success": true, "data": { /* whatever that channel returned */ } }
```

| Side | Where |
|---|---|
| Route | `fincra-integrations/src/routes/gateway.ts` |
| Controller | `fincra-integrations/src/controller/gateway.ts` |
| Inbound schema | `fincra-integrations/src/validation/gateway.ts` |
| Dispatch | `channelService.initiateChannel(req.body)` |

The inbound Joi schema is the whole of the declared contract today:

```ts
channelName: Joi.string().required(),
channelEntityName: Joi.string().optional(),
action: Joi.string().required(),
data: Joi.object().optional(),
```

`data` is `Joi.object()`. **The payload that carries the money is unvalidated
and untyped on both sides.**

### The five call sites

| File | Line | Purpose |
|---|---|---|
| `src/components/disbursements/disbursementsRepository.ts` | 254 | `callChannelViaGateway` |
| `src/components/disbursements/disbursementsRepository.ts` | 770 | `uploadTransactionDocument` |
| `src/components/disbursements/disbursementsRepository.ts` | 793 | `getChannelStatus` |
| `src/components/disbursements/payouts/repos/PayoutsUtilRepository.ts` | 955 | payout path |
| `src/components/transactionStatusQuery/transactionStatusQueryRepository.ts` | 20 | status query |

Each one builds its own `axios.post` or `httpService.post`. There is no client
class, no shared type, and the argument is `data: any`.

### The surface, counted

Actions sent by disbursements (from `action: "..."` literals):

```
initiate  getDisbursement  disbursement  settlement  disburse  verifyTransaction
validateDisbursement  run  getWithdrawal  getPayoutStatus  fetchTransfer
conversion  authenticate
```

Channels named by disbursements:

```
clearJunction  complyAdvantage  globus  korapay  mfsAfrica
nedbank  opay  quidax  rave
```

13 actions × 9 channels is **not** 117 contracts, because most pairs do not
exist. But it is the reason this cannot be done as one interaction and declared
finished.

`fincra-integrations/src/deccs/gate.ts` already names the money path:

```ts
const CLASSIFIED_ACTIONS = new Set(["disburse", "gettransactions", "getdisbursement"]);
```

**Use that same set.** Those three actions are where a contract break costs
money. Start there and nowhere else.

---

## 2. Why the demo repositories do not transfer directly

The `disbursement-service` / `switch-service` pair proved the mechanism. Four
things are different here, and each one changes the work.

**One endpoint, many logical operations.** A pact interaction is
request-plus-response. Here the request is distinguished by `channelName` and
`action` inside the body, not by path or method. Every interaction must fix
those two values exactly and match the rest loosely. Provider states become
`"channel rave supports getDisbursement and the transaction is successful"`.

**There is nothing to write a consumer test against.** The demo had a
`SwitchClient` class. Here the call is `axios.post(url, data)` with `data: any`
in five places. A consumer pact test asserts that *the client can read the
response*; with no client there is nothing to assert on. **This is the single
biggest blocker, and it is a refactor, not a test.**

**The response is passed through, not parsed.** The gateway returns whatever the
partner returned. Disbursement then maps `data` onto the payout — channel
reference and status. That mapping is the real contract, and it is currently
implicit. The fields that matter are the ones the payout reads.

**A live gate already exists, and it is additive.** DECCS appends `mappedError`
to gateway responses (`src/deccs/gate.ts`). Any contract must treat it as
**optional**, or turning DECCS on and off will break the contract test for a
reason unconnected to the wire.

---

## 3. What already exists, and should be used

Do not build a parallel structure. Both repositories already have what is
needed.

| Asset | Where | Use it for |
|---|---|---|
| `*.gate.spec.ts` lane, vitest, 58 specs | `fincra-disbursements/vitest.config.ts` | The lane the pact tests join |
| `test:gate` script | both `package.json` | The command CI already runs |
| `channelMock` | `fincra-integrations/src/shared/channelMock/` | **Provider states** |
| `test.yml` on push and pull request | both `.github/workflows/` | Where the gate hooks in |
| `dev.yml`, `sandbox.yml`, `tag.yaml` | both | What the gate must block |

`channelMock` deserves attention. It already:

- flips channel outcomes live from general-config, with no redeploy
- refuses to engage when `NODE_ENV === "production"`
- forces an explicit body for success outcomes, because a synthetic body would
  give a payout a garbage reference

That is a provider-state mechanism that someone has already thought hard about.
A pact provider state handler should set a `channelMock` rule and clear it
afterwards. **Do not write a second mocking layer.**

---

## 4. The plan

Five stages. Each one is shippable on its own and leaves the system better than
it found it. Stop after any stage and nothing is half-built.

### Stage 0 — Give the boundary a client (no pact yet)

**This is the prerequisite. Nothing else is possible without it.**

Add `src/clients/integrationsGateway/` to `fincra-disbursements`:

```ts
// The one place this service talks to fincra-integrations.
export interface GatewayRequest<TData = unknown> {
  channelName: string;
  channelEntityName?: string;
  action: string;
  data?: TData;
}

export interface GatewayResponse<TData = unknown> {
  success: boolean;
  data: TData;
  mappedError?: MappedError;   // DECCS, additive, may be absent
}

export class IntegrationsGatewayClient {
  async call<TReq, TRes>(req: GatewayRequest<TReq>): Promise<GatewayResponse<TRes>>;
}
```

Rules for the client, all of which the current code lacks in at least one place:

1. **Validate the response before any business logic reads it.** A partner can
   answer HTTP 200 with the failure in the body, and this codebase already knows
   that — `isPayoutNotInitiatedError` exists at
   `disbursementsRepository.ts:270`. Move that class of check into the client.
2. **One timeout, from `INTEGRATIONS_TIMEOUT_IN_SECONDS`.** Today the fallback
   `70000` is written inline at the call site.
3. **Type the money-path actions.** `disburse`, `getDisbursement`,
   `verifyTransaction` get named request and response types. The rest may stay
   `unknown` until they are needed.
4. **Do not change behaviour.** Move the five call sites onto the client and
   nothing else.

Value even if the plan stops here: one place to change a timeout, one place to
add a retry, one place to read.

Effort: judgement, roughly two to three days including moving the call sites.

### Stage 1 — Stand up the broker

A shared, long-lived Pact Broker. The full deployment is in
`platform-infra/deploy/cloud-run/`, already proven against a real project.

Decisions to make before deploying:

- **Where.** Cloud Run costs about ten to fifteen US dollars each month and is
  reachable from GitHub-hosted runners. Anything inside the VPC needs
  self-hosted runners, or every gate silently skips.
- **Read is authenticated.** `PACT_BROKER_ALLOW_PUBLIC_READ=false`. A contract
  states the shape of a payment API, field by field.
- **One broker for all seventeen services**, not one per pair. That is the whole
  point of a broker.

Effort: half a day, most of it waiting.

### Stage 2 — One interaction, end to end

Pick **`getDisbursement` on one channel**. It is a read, so a wrong move costs
nothing, and it exercises the full loop.

Consumer side, in `fincra-disbursements`, joining the existing lane as
`integrationsGateway.pact.spec.ts`:

```ts
provider
  .given("channel rave has a successful disbursement for the reference")
  .uponReceiving("a request for the status of a disbursement")
  .withRequest({
    method: "POST",
    path: "/integration/gateway",
    body: {
      channelName: "rave",              // exact: it selects the channel
      action: "getDisbursement",        // exact: it selects the operation
      data: { reference: like("FCR-123") },
    },
  })
  .willRespondWith({
    status: 200,
    body: {
      success: boolean(true),
      data: {
        // ONLY the fields the payout actually reads. Nothing else.
        status: regex(/^(successful|failed|pending)$/, "successful"),
        reference: like("FCR-123"),
      },
    },
  });
```

The rule that keeps this maintainable: **put in the contract only the fields
this service reads.** The gateway passes through whatever the partner sent. If
the contract lists every field a partner happens to return, then a partner
changing an unread field breaks a Fincra build for no reason.

Provider side, in `fincra-integrations`, with the state handler setting a
`channelMock` rule and clearing it in teardown.

Effort: judgement, roughly three to four days for the first one, because it
includes learning. Later ones are hours.

### Stage 3 — Turn the gate on, in warn mode first

Add `contract-gate` to `test.yml` in both repositories. **For the first two
weeks it must not fail the build.** Run it, publish, and let people watch it.
A gate that fails on the day it lands gets switched off in a week.

Then, and only then, make the deploy workflows (`dev.yml`, `sandbox.yml`,
`tag.yaml`) depend on it. That single dependency is the entire mechanism.

Two settings that are not optional:

- **`enablePending: true`.** A new expectation must not break a provider that
  has never seen it. Beware the consequence: a contract nobody has verified yet
  reports failures but does not fail the build. It becomes fatal only after the
  first successful verification.
- **Webhooks.** Without one, a consumer change never triggers the provider
  build, `can-i-deploy` answers "unknown" forever, and someone removes the gate.

Effort: two days, then two weeks of watching.

### Stage 4 — Widen to the rest of the money path

Add `disburse` and `verifyTransaction`. Then the channels that actually carry
volume, which the team knows and this document does not.

**Do not aim for coverage of all 13 actions.** Contract-test what breaks money
when it drifts. `getBanks` and `getBalance` do not need a pact.

---

## 5. Wiring into the existing CI

Both repositories run `test.yml` on pull request and on push to `dev` and
`main`. Deploys are separate workflows.

```
test.yml            (exists)  →  contract-gate  →  dev.yml / sandbox.yml / tag.yaml
```

The gate itself should be one script, `ci/contract-gate.sh`, so it runs the same
way on a laptop as in CI. A gate that only exists inside a YAML file cannot be
tested and nobody can run it before they push.

Secrets needed in both repositories: `PACT_BROKER_BASE_URL`,
`PACT_BROKER_USERNAME`, `PACT_BROKER_PASSWORD`.

The version is the git SHA. The branch is the git branch. Never write a version
in code.

---

## 6. Things that will bite, all seen in practice

These cost real time on the proof-of-concept. Each one fails with a message that
points somewhere else.

| Symptom | Cause |
|---|---|
| `No pacts found matching the given consumer version selectors`, while every contract is present | The pacticipant's `mainBranch` is unset. `PUT /pacticipants` replaces the record and erases it. Use `POST` to create and `PATCH` to amend. |
| `can-i-deploy` says YES for a version nobody published | An empty matrix reports `deployable: true`, because nothing is missing when nothing is expected. Treat zero rows as a failure. |
| `can-i-deploy` against an environment can never pass | Nothing is recorded as deployed there yet, and only a deploy can record it. Fall back to the main-branch comparison until the first deploy is recorded. |
| `record-deployment` returns 404 "document not found" | That endpoint takes the environment **UUID**, not its name. Read `pb:record-deployment` off the version resource. |
| The gate fails slowly and blames the wrong thing | A retry loop that re-asks a different question than the one it fell back to. |
| A provider verification fails but does not fail the build | The contract is still pending. Pending ends after the first successful verification. |
| A break test poisons everyone's gate | It was run against the shared broker. The failed verification lands on `main` and blocks every other service. Run it against a broker started inside the pipeline. |

---

## 7. What this will not do

State these before starting, so nobody expects them.

- **It does not test behaviour.** It tests the shape of the wire. Whether a
  payout actually reaches the bank is an end-to-end question.
- **It does not test the partners.** The contract is between two Fincra
  services. Providus changing its API is a different problem, which
  `channelMock` and DECCS already address.
- **It does not replace the existing gate specs.** The 58 `*.gate.spec.ts` files
  test invariants that no contract test can see.
- **It does not remove the need for `data: any` to become typed.** Contract
  testing makes the untyped payload visible; it does not fix it.

---

## 8. Suggested order and rough effort

Effort figures are a judgement from reading the code, not a measurement.

| Stage | Work | Rough effort | Value if you stop here |
|---|---|---|---|
| 0 | One client for the gateway | 2–3 days | One place to change a timeout or a retry |
| 1 | Broker on Cloud Run | 0.5 day | Ready for every other service too |
| 2 | First interaction, both sides | 3–4 days | Proof on the real boundary |
| 3 | Gate in warn mode, then blocking | 2 days + 2 weeks | Drift becomes visible, then blocked |
| 4 | `disburse`, `verifyTransaction`, volume channels | 1–2 days each | The money path is covered |

Stage 0 is worth doing whatever is decided about contract testing.

---

## 9. The first decision

**Do stages 0 and 1 in parallel.** They do not depend on each other, and both
have standalone value. Stage 0 needs a disbursements engineer; stage 1 needs
someone with GCP access for half a day.

Nothing after that should start until stage 0 is merged, because there is
nothing to write a consumer test against until there is a client.

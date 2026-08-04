#!/usr/bin/env node
// Creates the broker environments and the verification webhooks.
//
// WHY THE WEBHOOK MATTERS
//
// The broker calls a webhook when a consumer publishes a NEW contract. The
// webhook starts the provider build, which verifies the new expectation and
// publishes the result.
//
// Without it, this happens:
//   1. Team A adds a field to its consumer expectation and merges.
//   2. The broker holds an expectation that nobody has verified.
//   3. can-i-deploy for team A answers "unknown" forever, so either the gate
//      blocks them for no clear reason, or somebody switches it off.
//   4. The break is found in production.
//
// The webhook is what closes that loop.
//
// Usage:
//   CI_PLATFORM=github  GITHUB_OWNER=... GITHUB_TOKEN=... node scripts/create-webhooks.mjs
//   CI_PLATFORM=gitlab  GITLAB_TOKEN=... GITLAB_PROJECT_DISBURSEMENT=123 \
//                       GITLAB_PROJECT_SWITCH=124 node scripts/create-webhooks.mjs
const BROKER = (process.env.PACT_BROKER_BASE_URL ?? 'http://localhost:9292').replace(
  /\/+$/,
  '',
)
const USER = process.env.PACT_BROKER_USERNAME ?? 'pact'
const PASS = process.env.PACT_BROKER_PASSWORD ?? 'pact'
const PLATFORM = process.env.CI_PLATFORM ?? null

const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')

/**
 * The two pairs. Note that each service is a provider in one pair, so BOTH
 * repositories need a webhook.
 */
const PAIRS = [
  { consumer: 'disbursement-service', provider: 'switch-service' },
  { consumer: 'switch-service', provider: 'disbursement-service' },
]

const ENVIRONMENTS = ['local', 'staging', 'production']

/** The branch that `mainBranch: true` selectors resolve against. */
const MAIN_BRANCH = process.env.PACT_MAIN_BRANCH ?? 'main'

/** Every service the broker needs to know about, taken from the pairs. */
const PACTICIPANTS = [...new Set(PAIRS.flatMap((p) => [p.consumer, p.provider]))]

async function brokerFetch(path, init = {}) {
  const response = await fetch(`${BROKER}${path}`, {
    ...init,
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      accept: 'application/hal+json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

async function ensureEnvironment(name) {
  const existing = await brokerFetch('/environments')
  const already = (existing.body?._embedded?.environments ?? []).some(
    (e) => e.name === name,
  )
  if (already) {
    console.log(`  environment ${name} is already there`)
    return
  }
  const created = await brokerFetch('/environments', {
    method: 'POST',
    body: JSON.stringify({
      name,
      displayName: name,
      production: name === 'production',
    }),
  })
  console.log(
    created.ok
      ? `  environment ${name} created`
      : `  could not create ${name} (status ${created.status})`,
  )
}

/**
 * Builds the request that the broker will send.
 *
 * The `${pactbroker.*}` values are filled in by the broker when it fires.
 */
function requestFor(provider) {
  if (PLATFORM === 'github') {
    const owner = requireEnv('GITHUB_OWNER')
    const token = requireEnv('GITHUB_TOKEN')
    return {
      method: 'POST',
      url: `https://api.github.com/repos/${owner}/${provider}/dispatches`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
      body: {
        // This must match the repository_dispatch type in ci.yml.
        event_type: 'contract-changed',
        client_payload: {
          pactUrl: '${pactbroker.pactUrl}',
          consumer: '${pactbroker.consumerName}',
          consumerVersion: '${pactbroker.consumerVersionNumber}',
        },
      },
    }
  }

  if (PLATFORM === 'gitlab') {
    const token = requireEnv('GITLAB_TOKEN')
    const projectId =
      provider === 'disbursement-service'
        ? requireEnv('GITLAB_PROJECT_DISBURSEMENT')
        : requireEnv('GITLAB_PROJECT_SWITCH')
    const host = process.env.GITLAB_HOST ?? 'https://gitlab.com'
    return {
      method: 'POST',
      url: `${host}/api/v4/projects/${projectId}/ref/main/trigger/pipeline?token=${token}`,
      headers: { 'content-type': 'application/json' },
      body: {
        'variables[PACT_URL]': '${pactbroker.pactUrl}',
        'variables[PACT_CONSUMER_VERSION]': '${pactbroker.consumerVersionNumber}',
      },
    }
  }

  const url = process.env.WEBHOOK_URL
  if (!url) return null
  return {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: {
      provider,
      pactUrl: '${pactbroker.pactUrl}',
      consumerVersion: '${pactbroker.consumerVersionNumber}',
    },
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`\n  ${name} is not set, and CI_PLATFORM=${PLATFORM} needs it.\n`)
    process.exit(1)
  }
  return value
}

async function main() {
  console.log(`broker ${BROKER}`)

  console.log('\nenvironments (can-i-deploy needs these):')
  for (const name of ENVIRONMENTS) await ensureEnvironment(name)

  // A webhook names a consumer and a provider, and the broker refuses one that
  // names a pacticipant it has never heard of. On a fresh broker nothing exists
  // until the first contract is published, so make sure they exist here.
  //
  // NEVER use PUT for this. PUT REPLACES the pacticipant, and a body of just
  // { name } silently erases its `mainBranch`. Every consumer version selector
  // that says `mainBranch: true` then resolves to nothing, the provider
  // verification reports "No pacts found matching the given consumer version
  // selectors", and can-i-deploy goes unknown. Nothing in the message points at
  // the cause, and the contract files are all still there.
  //
  // Create only what is missing, and always state the main branch.
  console.log('\npacticipants:')
  for (const name of PACTICIPANTS) {
    const existing = await brokerFetch(`/pacticipants/${encodeURIComponent(name)}`)
    if (existing.ok) {
      if (existing.body?.mainBranch) {
        console.log(`  ${name} exists, main branch ${existing.body.mainBranch}`)
        continue
      }
      // It exists but has no main branch. PATCH only touches what it names.
      const fixed = await brokerFetch(`/pacticipants/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ mainBranch: MAIN_BRANCH }),
      })
      console.log(
        fixed.ok
          ? `  ${name} had no main branch, set to ${MAIN_BRANCH}`
          : `  ${name} main branch could not be set (${fixed.status})`,
      )
      continue
    }

    const created = await brokerFetch('/pacticipants', {
      method: 'POST',
      body: JSON.stringify({ name, mainBranch: MAIN_BRANCH }),
    })
    console.log(
      created.ok ? `  ${name} created` : `  ${name} failed (${created.status})`,
    )
  }

  console.log('\nwebhooks:')
  for (const pair of PAIRS) {
    const request = requestFor(pair.provider)
    if (!request) {
      console.log(
        `  skipped ${pair.provider}: set CI_PLATFORM=github or gitlab, or WEBHOOK_URL`,
      )
      continue
    }

    const uuid = `verify-${pair.provider}-for-${pair.consumer}`
    const result = await brokerFetch(`/webhooks/${uuid}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: `verify ${pair.provider} when ${pair.consumer} publishes`,
        // Only when the CONTENT changed. A republication of the same contract
        // needs no new verification, and a webhook that fires on every
        // publication turns the build system into noise.
        events: [{ name: 'contract_content_changed' }],
        provider: { name: pair.provider },
        consumer: { name: pair.consumer },
        request,
      }),
    })
    console.log(
      result.ok
        ? `  ${uuid} is set`
        : `  ${uuid} failed with status ${result.status}: ${JSON.stringify(result.body)}`,
    )
  }

  if (!PLATFORM && !process.env.WEBHOOK_URL) {
    console.log(
      '\nNo webhook was created, and that is fine for local work: there is no\n' +
        'build system on a laptop to call. In continuous integration the webhook\n' +
        'is NOT optional. Without it a consumer change is silent until the next\n' +
        'provider build, and can-i-deploy answers "unknown" forever.\n',
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

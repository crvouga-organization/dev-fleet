# Provider accounts

**The rule.** Provider accounts exist only as the CLI proxy's credential files
on the manager. Every node and IDE gets a view derived from them, and nothing
on a node holds a provider login of its own. T3 offers one instance per
account, named `<Provider> <account email>`, and every launcher reaches the
provider through the proxy.

## The roster

```sh
npx @crvouga/homelab accounts            # provider, index, label, state, cooldowns and when they clear
npx @crvouga/homelab accounts --diff     # and what this machine offers against it
```

Each account has one state, derived from its credential file and the proxy's
management API:

| State             | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `usable`          | Serves requests                                                            |
| `cooling-down`    | The provider limited it; `until` says when it clears, when the proxy knows |
| `refresh-failing` | Its token refresh fails for now, and its access token is still valid       |
| `needs-login`     | The provider refused its refresh token: only signing in again helps        |
| `removed`         | Disabled on the proxy                                                      |

The proxy also holds back single models: an account out of quota for one
model still serves its others. Such an account stays `usable`, and its
`cooldowns` name each model held back, the proxy's reason (`quota`,
`payment_required`, …) and `until`. `proxy:account:<provider>` says so in its
summary: "account 1 cooling-down on MODEL until …".

The index of an account is its position among its provider's accounts, sorted
by sign-in email. Checks name accounts by provider and index only.

The **roster version** is a digest of the routing prefixes of the accounts.
The manager computes it from the credential files and every node from the
proxy's model list, so the two agree exactly when a node offers what the
proxy holds.

## Checks

| Check                              | Fails when                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `proxy:account:<provider>`         | The provider has no usable account; it warns below `services.proxy.accounts.minimumUsable` (default 2) |
| `accounts:roster-current`          | The node offers another roster version than the proxy's                                                |
| `accounts:native-login`            | (warns) An agent CLI on the node keeps a provider login of its own                                     |
| `proxy:reachable-from`             | The node gets no answer from the proxy; it warns above two seconds                                     |
| `agent:<tool>:account-<n>:session` | That account's instance does not run a session (see below); it warns while the account is cooling down |
| `agent:<tool>:removed-<n>:session` | The node still offers an instance for an account the proxy no longer holds                             |
| `t3:models`                        | (warns) An account's instance shows or starts on a model its account does not serve                    |

A session check that does not pass says which of these it found:

| Summary starts with                   | Status | Meaning                                                                                        |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `AGENT_ACCOUNT_COOLING_DOWN`          | warn   | The provider limited the account. It clears on its own                                         |
| `AGENT_ACCOUNT_VERIFICATION_REQUIRED` | fail   | The provider answers "Verify your account": a person completes it with the provider            |
| `AGENT_ACCOUNT_AUTH_REJECTED`         | fail   | The account's credentials were refused; `accounts` says whether it needs a login         |
| `AGENT_ACCOUNT_SESSION_TIMED_OUT`     | fail   | The session never ended, and the proxy named no cooldown and no refusal. Not a sign-in failure |
| `AGENT_ACCOUNT_SESSION_FAILED`        | fail   | Anything else                                                                                  |

OpenCode retries a request the proxy refuses until the session's deadline and
prints nothing, so a limited account ends as a timeout. A node then asks the
proxy for that account's model directly, with its own client key: a model the
proxy holds back for a limit answers 429 at once, without a request to the
provider, and the session is `AGENT_ACCOUNT_COOLING_DOWN`. An account the
proxy holds back because its provider refused it answers 503 with the
provider's last words, read for a verification ("Verify your account", or the
reason `VALIDATION_REQUIRED`) or refused credentials. A model it does not hold
back is asked of the provider once, with one bounded request, and its answer
is read the same way. A report never repeats what the provider said.

A cooling-down session names when the cooldown clears, when the proxy says
so: "… is rate limited until 2027-01-15T09:30:00Z". The instant is read from
the `Retry-After` of the proxy's 429 (else the `reset_seconds` of its
`model_cooldown` error), or from the instant the fleet's relay prints when it
refuses a request for an account it holds back. An answer that names no time
adds none to the summary; `accounts` still lists `until` per model. The
proxy names a time when the provider did: a limit the provider gave no time
for is held for a moment and asked again.

`features/accounts/proxy-box.feature` runs the pinned proxy in a container
against a stand-in provider, on every pull request, so these answers are the
proxy's own and not an assumption: the 429 and its `Retry-After`, the
`model_cooldown` error of the OpenAI protocols, and the 503 that carries a
provider's demand for verification.

Session results are cached under a key that holds the roster version and the
version of the client key, so any account change or key rotation re-verifies
at once. A pass is reused for six hours.

A session that cannot pass must not hold every sync up for its 150 second
deadline on every node:

- The proxy is asked for the account's model **before** the session is
  launched. An account it holds back, wants verified or refuses is reported
  at once and no session is started.
- What a session found when it did not pass is taken as found for ten
  minutes. Its check says so: "(found 4m ago; a session that does not pass is
  run again after 10m or on any change)".
- A session that ran into its deadline is given 30 seconds the next time,
  until it passes or six hours have gone by.

## Models per account

Accounts of one provider are not entitled to the same models. Each tool has
preferred defaults, in order (`proxy.accounts` in `agents/registry.json`): an
account's launcher and its T3 instance start on the first one the account
serves. In T3, an account's instance hides the models of T3's catalogue that
its account does not serve (`providerModelPreferences` in T3's settings), so
it shows only what works; `sync` writes that, and shows a model again
when the account serves it. T3 opens an instance on its own catalogue's
default when the account serves it, and on the first preferred default
otherwise.

`t3:models` warns with `T3_MODELS_MISMATCH` when an account serves none of
its tool's preferred defaults (it then starts on its first model by name) or
nothing of T3's catalogue.

## Adding, signing in again, removing

```sh
npx @crvouga/homelab accounts --add claude
npx @crvouga/homelab accounts --relogin codex 2
npx @crvouga/homelab accounts --remove codex 2
```

A sign-in writes into a staging directory beside the credentials; only a
complete credential is moved in, with one rename, so an interrupted sign-in
leaves nothing behind. Routing prefixes are applied in the same command. Every
change is then propagated to every node.

## Propagation without a full sync

```sh
npx @crvouga/homelab converge --only accounts
```

On the manager and every worker at once, each node re-reads the proxy's
roster and rewrites only its per-account T3 instances and the models each
shows. T3 watches its settings, so nothing restarts and no running turn ends. Instance ids derive
from the account's routing prefix and stay the same. A node that cannot be
reached catches up on the next propagation or sync; until then
`accounts:roster-current` reports the version it has.

## Choosing an account

Unpinned requests go through a loopback relay on every node. When the fleet
declares a policy for a provider, the relay picks the account of each request:

```json
"services": {
  "proxy": {
    "endpoint": "https://cli-proxy.example.com",
    "accounts": {
      "minimumUsable": 2,
      "selection": {
        "codex": { "strategy": "fill-first", "order": ["a@example.com"] }
      }
    }
  }
}
```

| Strategy                 | Order                                            |
| ------------------------ | ------------------------------------------------ |
| `fill-first`             | The same order for every request                 |
| `round-robin`            | Each request starts one account further along    |
| `least-recently-limited` | The account limited longest ago (or never) first |

The order is the accounts `order` names, in that order, then the others in
the order of their routing prefix. A quota or authentication refusal sends
the request on to the next account, and the refused one cools down for its
`Retry-After` (a minute without one). Without a policy the proxy's own
fill-first pool chooses. An instance pinned to one account answers "This
account is cooling down until …" and names the other instances of its
provider.

## Proxy outages

Every relayed launch (Claude, Codex, Gemini and Antigravity, pinned or not)
retries a proxy that does not answer for about a minute. If it stays down,
the agent gets one distinct, retryable error: "The CLI proxy has been
unreachable since …".

## Checkpoints and the proxy state

Each checkpoint records a short digest of every credential's refresh token,
never the token. After restoring an older checkpoint, `restore-verify
RESTORED --newest NEWEST` names exactly the accounts whose refresh token the
provider has since replaced (`needs-login: <provider> <index>`).

`cliproxy/scripts/lease.py` is a fencing lease on the proxy state: a second
proxy cannot take it while the first holds it, and taking over an expired
lease fences the old holder.

## Client keys

`homelab proxy issue-key|rotate-key|retire-key|revoke-key NODE` keep one
proxy client key per node in the manager's key ring. A rotation keeps the old
key accepted until `retire-key`, so no running agent fails while nodes move
over. Revoking one node's key leaves the others working.
`homelab proxy client-keys` reports each node's key by fingerprint only.

## Not yet done

- The proxy does not notify anyone when an account turns `needs-login`, and
  no watcher on the manager triggers propagation or a checkpoint when a
  credential file changes. Run `converge --only accounts` or
  `accounts` instead.
- Nothing forces a refresh of every account after a restore. The digest
  comparison above is offline.
- The lease is not yet taken by the proxy service at start, and its
  production store (the checkpoint bucket) is not wired.
- Per-node client keys are not yet distributed to nodes through the secrets
  provider, so nodes still present the shared key. No
  `proxy:client-key-current` check exists yet.
- OpenCode and Grok read the proxy's address from rendered configuration and
  are not relayed yet. There is no warm standby proxy.
- The selection policy is applied by the client relay; the proxy itself stays
  fill-first.
- A sign-in uses the provider's device code where the proxy offers one.
  Other providers print a callback URL, and no loopback forward is managed
  for them.

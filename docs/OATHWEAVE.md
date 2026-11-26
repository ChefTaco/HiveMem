# Direct browser authorization

The optional suite integration verifies RS256 credentials against explicit
`OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL` and `OATHWEAVE_USERINFO_URL` HTTPS
configuration. Configure all three together; the issuer is the browser issuer
selected in Oathweave, not an inferred native JWT issuer. TLS verification and
online session revocation are mandatory. Tokens have one exact product audience
and a maximum fifteen-minute lifetime. Permissions are not inferred from roles.
Native machine credentials and standalone authentication remain available.
Verification uses the shared `@hivemagnus/hive-common` Oathweave verifier with no
clock tolerance and an online session check on every request; tokens must carry a
`roles` array and a `clientId` claim. The shared verifier fetches and caches
`OATHWEAVE_JWKS_URL` itself (bounded cache age, a cooldown on unknown key IDs, no
redirects, request timeouts).

An operator may opt into reusing a userinfo answer for up to five seconds with
`HIVEMEM_OATHWEAVE_SESSION_CACHE_MS` (an integer from `0` to `5000`; unset or `0`
keeps the check on every request). HiveXUI memory pages send several requests at once,
so a window of 2000-5000 ms cuts Oathweave load while a signed-out session still stops
working within that window. A failed check is never reused as a success.

`HIVEMEM_OATHWEAVE_IDENTITIES_JSON` is a protected JSON array of explicit account links:

```json
[{"issuer":"https://identity.example.com","subject":"example-subject","localId":"existing-product-identity","credentialGeneration":0}]
```

`localId` means existing agent ID that owns the intended memory/workspace data. Unlinked subjects are denied.
The account must already exist and be active. `credentialGeneration` pins the
reviewed product credential generation (zero when omitted); it is not copied from
the identity token. An existing rotated account needs its current generation in
the reviewed mapping. Further rotation or disabling invalidates the link until
explicit review and configuration update. Browser requests never create accounts
or synchronize the pin to newer credentials automatically.
A link may add `scopes`, a ceiling on what that user may ever receive in HiveMem:

```json
[{"issuer":"https://identity.example.com","subject":"example-subject","localId":"existing-product-identity","scopes":["memories:read","sessions:read"]}]
```

Without `scopes`, every `hivemem:` permission Oathweave grants applies, so any role holding
`hivemem:admin:all` makes the user a HiveMem administrator. With it, permissions outside the
ceiling are dropped (a granted wildcard such as `hivemem:*` narrows to the listed scopes, and a
listed wildcard such as `memories:*` keeps only what Oathweave grants): Oathweave can narrow,
never widen, the link. Put `admin:all` in the ceiling only for reviewed administrators.
Duplicate issuer/subject links, extra fields, and email-based mappings are rejected.
Do not put live links or credentials in Git. Prepare and review links independently
for each installation before applying configuration. No API request creates a
replacement identity to impersonate a legacy account.

## Guided installation-owned administrator setup

Hive can create a separate memory principal for a new administrator through the running HiveMem
writer. This does not copy another principal's memories, workspaces, credentials or account ID.
The installation then publishes its reviewed exact Oathweave account link in the normal managed
configuration. An Oathweave role alone never creates that link.

The optional `HIVE_ADMIN_PROVISIONING_SECRET` is an independent, randomly generated 64-character
lowercase hexadecimal secret held only by the installation owner and HiveMem. Leave it absent to
disable this boundary. It cannot authorize memory access, token issuance, credential rotation,
account activation or edits to an existing principal. Keep it out of browser configuration, source
control, logs and command-line arguments.

The owner calls `POST /internal/hive/admin-accounts/{operationId}` from inside HiveMem's container
over verified loopback HTTPS, with `x-hive-admin-provisioning-secret`. `operationId` is a UUID. The
strict JSON body is `{version:1,issuer,subject,local_id,username,display_name?}`; `issuer` must equal
the configured `OATHWEAVE_ISSUER`. The socket peer must be loopback. Browser and proxy provenance
headers, cookies and authorization bearers are rejected even when the secret is supplied.

The first response is 201 and an exact retry is 200, both after persistence. The receipt contains
the operation ID, issuer, subject, native principal ID, username, display name, request SHA-256,
creation time, active status and credential generation zero; it contains no bearer token. A
matching authenticated `GET` reads the same receipt and checks that the principal still matches.
Changing the request or reusing an existing ID or subject from another operation answers 409.
Missing, disabled, rotated or changed principals also answer 409 rather than being recreated.

The principal and receipt use the existing persistence snapshot and recovery format. Back up and
restore both together. If persistence fails, the response is 503 and the outcome remains
indeterminate; recover by reading or explicitly retrying the same operation and exact request.
The retry can persist the retained checkpoint without creating a replacement identity. Keep the
same operation ID until that outcome is established.

## Service identities

Another product can call HiveMem with a short-lived Oathweave service-account token,
obtained with the client credentials grant, instead of a long-lived HiveMem bearer
token. `HIVEMEM_OATHWEAVE_SERVICES_JSON` is a protected JSON array of explicit
service links; it needs `OATHWEAVE_JWKS_URL`:

```json
[{"issuer":"oathweave-example","clientId":"example-service","localId":"example-service","scopes":["memories:read"]}]
```

`issuer` is the Oathweave native `JWT_ISSUER` that signs client credentials tokens
(not the browser issuer), and `clientId` is the machine client. A native issuer is a
lowercase identifier matching `^[a-z][a-z0-9-]{0,63}$`; a client whose machine policy
selects the browser issuer is linked with that https issuer instead. Any other issuer
shape is refused at startup. Service tokens use the same shared verifier and JWKS
endpoint as browser tokens. A token is accepted
only when it is signed by the configured JWKS, names exactly one linked issuer and
client (`sub` and `clientId` agree), has the audience `hivemem`, is an access token
of the `SERVICE_ACCOUNT` actor type without a user session, and lives at most fifteen
minutes. Its `hivemem:` permissions become HiveMem scopes, limited to the link's
`scopes`: Oathweave can narrow, never widen, what the service may do. A token with no
linked scope is refused.

The request runs as `localId`. It needs no registered agent, but disabling an agent
with that ID contains the service at once. A service principal cannot exchange its
token for a HiveMem token at `/v1/auth/refresh`; it renews through Oathweave. Each
service fetches a new token before the previous one expires, so no renewal job or
manual rotation exists for this credential. Revoke it in Oathweave by deactivating
the client or changing its secret; tokens already issued expire within their
lifetime.

### Audit export collectors

A security collector reads the suite audit export, `GET /v1/audit/export`, with a service
token that holds the Oathweave permission `hivemem:audit:read`. Link it with only that
scope:

```json
[{"issuer":"oathweave-example","clientId":"example-collector","localId":"example-collector","scopes":["audit:read"]}]
```

Oathweave signs client-credentials tokens with its native issuer by default: put that
identifier (its `JWT_ISSUER`, for example `hive-iam`) in the link's `issuer`, which passes it
to the shared verifier's `nativeIssuers`. No separate setting is needed.
`audit:read` is honoured only for service tokens: a HiveMem bearer token naming it is
refused. It reaches no memory or admin route. Administrators may also read the export.

### Enrolling agents as a service

A product that creates agents, such as a fleet manager, can enroll them with its service
identity instead of a long-lived admin token. Link it with exactly the scopes it uses and
give its Oathweave machine client the same `hivemem:` permissions:

```json
[{"issuer":"oathweave-example","clientId":"example-fleet","localId":"example-fleet",
  "scopes":["admin:agents","workspaces:write","memories:read","memories:write","sessions:read","sessions:write"]}]
```

`workspaces:write` lets it create the workspace its agents join (`POST /v1/workspaces`, which
returns the existing workspace when it already exists); the creator owns it and so holds the
workspace admin right enrollment needs. `admin:agents` reaches the durable actor-credential API
(`POST /v1/actor-credentials/{operationId}`) to enroll, rotate, renew and disable agents in a
workspace it administers. Agent credentials last at most 720 hours, so a product that keeps agents
running renews each one before its deadline (see [CONSOLE_API.md](CONSOLE_API.md)). It can grant an agent only scopes it holds itself, and never an `admin:` scope.
Leave out `admin:agents` in the link and an Oathweave grant of it has no effect. The link does
not reach `/v1/admin/*`, which needs `admin:all`.

The integration is under development. A passing unit suite does not authorize
production adoption. Restore rehearsal, permissions, native clients, and browser
workflow parity must pass before switching an existing installation.

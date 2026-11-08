# Direct browser authorization

The optional suite integration verifies RS256 credentials against explicit
`OATHWEAVE_ISSUER`, `OATHWEAVE_JWKS_URL` and `OATHWEAVE_USERINFO_URL` HTTPS
configuration. Configure all three together; the issuer is the browser issuer
selected in Oathweave, not an inferred native JWT issuer. TLS verification and
online session revocation are mandatory. Tokens have one exact product audience
and a maximum fifteen-minute lifetime. Permissions are not inferred from roles.
Native machine credentials and standalone authentication remain available.

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
Duplicate issuer/subject links, extra fields, and email-based mappings are rejected.
Do not put live links or credentials in Git. Prepare and review links independently
for each installation before applying configuration. No API request creates a
replacement identity to impersonate a legacy account.

## Service identities

Another product can call HiveMem with a short-lived Oathweave service-account token,
obtained with the client credentials grant, instead of a long-lived HiveMem bearer
token. `HIVEMEM_OATHWEAVE_SERVICES_JSON` is a protected JSON array of explicit
service links; it needs `OATHWEAVE_JWKS_URL`:

```json
[{"issuer":"oathweave-example","clientId":"example-service","localId":"example-service","scopes":["memories:read"]}]
```

`issuer` is the Oathweave native `JWT_ISSUER` that signs client credentials tokens
(not the browser issuer), and `clientId` is the machine client. A token is accepted
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

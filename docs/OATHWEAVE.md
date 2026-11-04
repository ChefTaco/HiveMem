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

The integration is under development. A passing unit suite does not authorize
production adoption. Restore rehearsal, permissions, native clients, and browser
workflow parity must pass before switching an existing installation.

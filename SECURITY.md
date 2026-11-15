# Security Policy

## Supported versions

Security fixes are released for the latest `1.x` version.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/HiveMem/security/advisories/new).
Please include:

- the affected component (server, TypeScript or Python SDK, or Hermes plugin) and version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Run every service over TLS in production, and keep admin listeners on a private network.
- Keep `.env` files, IAM signing keys, and TLS keys readable only by root or the service user.
- Rotating `HIVEMEM_JWT_SECRET` invalidates every token at once; see [ts-core/README.md](ts-core/README.md)
  for token issuance, refresh and revocation.

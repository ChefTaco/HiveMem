# Changelog

All notable changes to `@hivemagnus/hivemem-sdk`.

## [1.1.0] - Unreleased

### Added

- `createWorkspace(workspaceId, options)` calls `POST /v1/workspaces` and returns the
  `WorkspaceRecord`. It is idempotent: an existing workspace the caller can read is returned
  unchanged. New `WorkspaceRecord`, `WorkspaceMember`, `WorkspacePolicy` and
  `WorkspaceCreateOptions` types.
- `tokenProvider` option for short-lived credentials such as Oathweave service tokens. It is
  called before each request and, after a 401, called again with `forceRefresh: true` and the
  request retried once. A static `token` keeps working unchanged.
- `headers` option: extra headers on every request, static or from a function called per
  request, for example to propagate `x-request-id` and `traceparent`. They cannot replace
  `Accept`, `Content-Type` or `Authorization`.

### Security

- Every request is sent with `redirect: "error"`, so a redirect can no longer carry the bearer
  token to another origin.

## [1.0.3]

- Earlier releases are described in the HiveMem repository changelog.

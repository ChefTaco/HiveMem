# Releasing @hivemagnus/hivemem-sdk

The TypeScript SDK is published to npm by `.github/workflows/publish-sdk.yml` when a tag
`sdk-vX.Y.Z` is pushed. It authenticates through npm trusted publishing (OIDC) and publishes
with provenance; no npm token is stored in the repository. The SDK is versioned separately
from the HiveMem server, whose image releases use plain `vX.Y.Z` tags.

1. Bump `version` in `sdks/typescript/package.json` (and `package-lock.json`, for example with
   `npm version X.Y.Z --no-git-tag-version` in `sdks/typescript`), and date the entry in
   `CHANGELOG.md`. Merge that to `main`.
2. Tag the merged commit and push the tag:

   ```sh
   git tag sdk-vX.Y.Z
   git push origin sdk-vX.Y.Z
   ```

3. Approve the waiting **Publish SDK** run on the `npm-publish` environment.

The workflow refuses to publish unless the `npm-publish` environment has a required reviewer
and the tag names exactly the version in `package.json`. Before publishing it runs
`npm audit --omit=dev`, the typecheck, build and tests, `npm pack --dry-run`, and
`npm run pack:check`, which checks the packed file list against an allowlist and imports the
installed tarball. A version already on npm is skipped, so re-running a tag is harmless.

## One-time setup

- GitHub: Settings > Environments > `npm-publish`, with at least one required reviewer.
- npm: on the `@hivemagnus/hivemem-sdk` package settings, add a trusted publisher for GitHub
  Actions with repository `ChefTaco/HiveMem`, workflow `publish-sdk.yml` and environment
  `npm-publish`.

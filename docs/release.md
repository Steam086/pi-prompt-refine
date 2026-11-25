# Release the native Pi package

The root package ships the native extension, the starter Preferences library and the English TUI guide. The Web subpackage is private. The manifest and pack check define the exact file list. [Manifest](../package.json) · [Pack check](../scripts/check-pack.mjs)

## Verify the candidate

Use a clean checkout of the candidate commit. Check the version in the manifest and lockfile, the changelog, license, repository URLs and install instructions in both READMEs. Review tracked files and public Git history for private sessions, sidecars, credentials and identifying experiment output. Git history and the npm tarball have different contents.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check:pack
npm audit --omit=dev --registry=https://registry.npmjs.org/
npm audit --registry=https://registry.npmjs.org/
```

Review runtime, host peer and development dependency findings. Check the candidate’s Linux CI run on the minimum supported Node version and Node 24. The offline tests run without model credentials. [CI workflow](../.github/workflows/check.yml)

Build and inspect the tarball outside the checkout. The smoke script uses a temporary Pi profile to install the package, check the starter library and registered commands, query status, and remove the package. Keep the candidate ref, tarball and pack metadata together. [Tarball smoke script](../scripts/smoke-pack.sh)

```sh
out=$(mktemp -d)
npm pack --ignore-scripts --json --pack-destination "$out" > "$out/pack.json"
archive="$out/$(node -p 'require(process.argv[1])[0].filename' "$out/pack.json")"
tar -tzf "$archive"
sh scripts/smoke-pack.sh "$archive"
npm publish "$archive" --dry-run --ignore-scripts --registry=https://registry.npmjs.org/
```

## Manual checks

Use a separate Pi profile, a synthetic draft and the exact candidate. Record the revision, OS, terminal, Node and Pi versions. For changes to native input or layout, check the shortcut, unfinished Chinese IME composition, resize, focus and Esc from both top-level tabs and child pages. Check that choosing or editing Preferences leaves the draft unsent. [TUI guide](tui-guide.md)

Real-provider checks require separate approval for the model and quota. For a changed rewrite flow, exercise the first shortcut run, accepting into the editor, capturing a second draft as Unsent, and cancelling the first direct-send confirmation. For changes to the rewrite policy, use the [semantic acceptance cases](optimizer-evaluation.md).

## Publish and verify

Get the owner’s approval for publication and for pushing a release tag. Confirm the npm package, account and dist-tag before using either route.

- **GitHub Actions.** Configure the package’s npm trusted publisher for this repository’s `publish.yml`. Push the approved stable tag matching the root version (`v<version>`). The workflow checks the version, tests on both Node versions, smoke-tests the tarball, then checks the Node 24 artifact’s integrity and publishes it to `latest` using OIDC. Keep the `npm-package` artifact. [Publish workflow](../.github/workflows/publish.yml) · [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- **Interactive publication.** Sign in to the public registry and verify the publisher with `npm whoami --registry=https://registry.npmjs.org/`. Publish the reviewed tarball with `npm publish "$archive" --ignore-scripts --registry=https://registry.npmjs.org/ --access public --tag latest`. Complete the account’s publishing authentication. [npm publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

Compare `npm view pi-prompt-refine@<version> dist.integrity` on the public registry with the retained `pack.json`. Verify `latest`, install the pinned npm version in a fresh Pi profile, check `/refine` and its starter Preference, then remove that exact source. Check the README links and the [Pi catalog listing](https://pi.dev/packages/pi-prompt-refine).

For a bad release, direct users to a known-good version or Git ref. They can remove the affected source shown by `pi list` and install the pinned version. Deprecate the affected version if appropriate and publish a reviewed fix under a new version. Local Refine data survives uninstall. [Local history and cleanup](tui-guide.md#local-history-and-cleanup)

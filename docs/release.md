# Publish the native Pi package

Release **the repository root only**. `pi-prompt-refine` is a source package: Pi discovers `src/extension.ts` via `pi.extensions`, supplies the Pi peers, and installs `ignore`. The `pi-package` keyword enables gallery discovery. No build step, CLI binary, install hook, or Web bundle is needed. Keep both reviewed example JSON files: the global starter library reads `examples/prompt-refine-preferences.json` at run time. `packages/pi-web` is private and is not a workspace to publish. See the [Pi package format](https://pi.dev/docs/packages) and the [implementation walkthrough](architecture.md).

## 1. Review the candidate before making it public

- Work from a clean checkout of the exact candidate commit. Check `git status --short`, the root version, lockfile, [changelog](../CHANGELOG.md), MIT notice, repository and issue URLs. Mark the first release as available in both READMEs only when it is available. Pin a version when testing upgrades or rollback.
- Review tracked files **and history** before making a Git repository public. npm's `files` list does not protect Git clones. Use synthetic examples. Review screenshots, fixtures, experiment notes, personal paths, session IDs, exports, sidecars, preferences, generated archives, `.env`, `.npmrc`, tokens and keys. Keep private experiment output outside the checkout. Do not paste potential secrets into an issue, CI log or scanner website. If a credential was exposed, revoke/rotate it first: editing HEAD or excluding a file from npm cannot retract old copies. Coordinate any history rewrite with the owner.
- Check package name, version, dist-tag, account ownership and 2FA/trusted publishing on the **public** registry. `npm view pi-prompt-refine versions --json --registry=https://registry.npmjs.org/` is read-only; a 404 does not reserve the name or prove publishing permission. Confirm that the copyright holder named in `LICENSE` and the npm publisher identity are intended to be public; do not silently change legal attribution. Use local npm authentication, never a token in this repo. No workflow here has permission to publish.

## 2. Verify without a model account

In a clean environment with Node 22.19 or later and no live-test environment flags:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check:pack
npm audit --omit=dev --registry=https://registry.npmjs.org/
npm audit --registry=https://registry.npmjs.org/
```

Install and registry audits require network access; the default tests and pack check do not need a provider or npm login. Inspect audit findings separately for runtime dependencies, Pi's host-provided peers, and the development lockfile. Do not automatically upgrade with `npm audit fix --force`. See [open release decisions](../TODO.md). CI checks the root package on Linux with the minimum Node version and Node 24; a workflow definition is not a passing external CI run.

Build one artifact outside the checkout. Review its contents, then install **that file** in isolation:

```sh
out=$(mktemp -d)
archive="$out/$(npm pack --ignore-scripts --silent --pack-destination "$out")"
tar -tzf "$archive"
sh scripts/smoke-pack.sh "$archive"
npm publish "$archive" --dry-run --ignore-scripts --registry=https://registry.npmjs.org/
```

The pack check compares the npm list to Git-tracked TypeScript and a short list of public files, and flags some common secret/path patterns without printing their values. It is not a general secret scanner. The smoke script uses a disposable HOME, Pi profile and consumer project; it installs the tarball with runtime dependencies but without peer copies, registers the installed directory with Pi, loads the manifest using the locked Pi SDK, checks both commands and the starter asset, then removes the registration. This is not a test of a registry install, real provider, terminal, or Web host.

### Checks run for the 0.1.0 candidate

Before the path-privacy and local cache fixes, on Linux x86-64, clean public-registry installs with the root lockfile (Pi 1.4.0) passed typecheck and the default suite on **Node 22.19.0 and 24.18.0**: 1,318 passed, 35 opt-in tests skipped on each. The actual package contained 67 files. The isolated tarball smoke test and `npm publish --dry-run` passed; no credentials, model calls, or publication were needed. Repository Markdown file targets and the relative links in the tarball resolved locally. This is local evidence, not a hosted CI result, macOS/IME acceptance, or a guarantee that the registry will accept the release.

After the path-privacy and local cache fixes, an isolated copy of the fixes and their tests passed typecheck and the default suite on Node 24.18.0 with the baseline Pi 1.4.0 lockfile (1,321 passed, 35 skipped). The working tree also passed typecheck, the default suite and the package file check. Re-run the tarball smoke test on the final artifact before publication.

## 3. Manual gate and recovery

Use the [TUI smoke checklist](macos-smoke-test.md) in a separate profile. Check startup, shortcut, narrow layout, IME, accept-without-send and uninstall. Use synthetic data and get permission before a test that will use quota. Record the exact ref, Node, Pi and terminal versions; do not record private drafts, paths, or credentials. Check that the docs linked from the npm README exist on the public repository at release time.

**Stop here unless the owner approves publishing this exact tarball.** Only then publish the reviewed `.tgz` to the public registry, record the matching Git ref, and verify `npm view pi-prompt-refine@<version> dist.integrity` against the pack integrity. Try `pi install npm:pi-prompt-refine@<version>` and remove that same source in a fresh profile. Do not test against a live session daemon or deploy Web.

For a bad release, stop recommending it, deprecate the affected version if appropriate, and publish a corrected **new** version after review. npm versions are immutable. Users can remove the source shown by `pi list`, then install an earlier known-good version or reviewed Git ref; for the first release, simply removing it disables it after reload. Uninstall is not data erasure: see [history and cleanup](tui-guide.md#local-history-and-cleanup).

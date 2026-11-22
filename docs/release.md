# Publish the native Pi package

Publish **the repository root**. The `pi-package` keyword makes the public npm package eligible for discovery in Pi's package catalog as a third-party extension. Pi documents this route without a separate catalog submission. The package already declares `src/extension.ts` in `pi.extensions`. Pi loads the TypeScript source, supplies the Pi peers and installs `ignore`. Keep both reviewed example JSON files because the global starter library reads `examples/prompt-refine-preferences.json` at runtime. Pi Web and T3 Code have separate integration instructions in the repository. [Pi package format](https://docs.pi.dev/latest/packages) · [Pi package catalog](https://pi.dev/packages) · [Implementation walkthrough](architecture.md)

## 1. Review the candidate before making it public

- Work from a clean checkout of the exact candidate commit. Check `git status --short`, the root version, lockfile, [changelog](../CHANGELOG.md), MIT notice, repository and issue URLs. Mark the first release as available in both READMEs only when it is available. Pin a version when testing upgrades or rollback.
- Review tracked files and public history, including screenshots, fixtures, experiments, personal paths, session IDs, exports, sidecars, local settings and credentials. Git exposes its history independently of npm's `files` list. Use synthetic examples and keep private experiment output outside the checkout. Run secret scans locally with redacted output. If a credential was exposed, revoke or rotate it at the issuer first. Coordinate any history rewrite with the owner.
- Recheck package name, version, dist-tag, account ownership and 2FA on the public registry. Use `npm view pi-prompt-refine versions --json --registry=https://registry.npmjs.org/` to check whether the name has a visible record. A 404 leaves ownership and availability unverified. Confirm the public npm publisher and copyright attribution. [npm public package publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- Choose interactive publication with 2FA or a separately approved workflow using npm trusted publishing. For the interactive route, confirm the active account with `npm whoami --registry=https://registry.npmjs.org/`. For CI, configure the trusted publisher and the matching workflow, and decide whether the workflow should stage for approval or publish directly. The repository's verification workflow is read-only. [npm trusted publishing and provenance](https://docs.npmjs.com/trusted-publishers/)

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

Install and registry audits require network access. The default tests and pack check need no provider or npm login. Inspect audit findings separately for runtime dependencies, Pi's host-provided peers, and the development lockfile. Require a passing Linux CI run on the final commit for the minimum Node version and Node 24. [Native TUI release tasks](roadmap.md#原生-tui-首发)

Build one artifact outside the checkout. Keep the pack JSON with the candidate ref, tarball and smoke results so you can verify the exact bytes after publication.

```sh
out=$(mktemp -d)
npm pack --ignore-scripts --json --pack-destination "$out" > "$out/pack.json"
archive="$out/$(node -p 'require(process.argv[1])[0].filename' "$out/pack.json")"
tar -tzf "$archive"
sh scripts/smoke-pack.sh "$archive"
npm publish "$archive" --dry-run --ignore-scripts --registry=https://registry.npmjs.org/
```

The pack check compares npm's file list with Git-tracked TypeScript and a short list of public files, and checks common credential and path patterns with values withheld. The smoke script installs the tarball in a disposable consumer project without Pi peer copies. It registers the package with the locked Pi CLI, starts a session in RPC mode, checks both registered commands, verifies `/refine-api status` leaves the transcript empty, checks the bundled starter JSON and removes the registration. Use the separate manual checks for terminal input and model behavior.

### 0.1.0 review on 2026-11-22

- The November 21 baseline passed both hosted CI jobs. Clean local installs with Pi 1.6.0 on Linux x86-64 passed typecheck and the default suite on Node 22.19.0 and 24.18.0, each with 1,339 passed and 35 opt-in skips. A pinned Git install loaded both commands in an isolated Pi profile and was removed successfully.
- The 68-file tarball built from the local review changes passed the package allowlist, the updated smoke test on both Node versions, and `npm publish --dry-run`. The dry run reported that a real publish requires login. A Linux pseudo-terminal also opened `/refine` and verified the starter Preference in a new profile without credentials.
- The maintainer reports that an earlier version underwent manual acceptance on macOS. Record the tested revision and environment if available. Use that run as the baseline when reviewing changes to the native workflow or Pi host for this release.
- The public-registry audits for the production and full root trees reported zero advisories. The registry lookup and Pi catalog page both returned 404 for `pi-prompt-refine`. Pi 1.6.0 was the npm `latest` host at review time.
- A redacted Gitleaks scan of local Git refs flagged a T3 keybinding identifier as a generic key. Source review confirmed it is a command identifier. A history review found old local paths in earlier versions of documentation and a test fixture. The release tree already uses public examples in those places.
- GitHub private vulnerability reporting was disabled at review time. The existing security policy supplies a fallback for requesting a private channel. [GitHub private vulnerability reporting settings](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)

## 3. Owner decisions and final acceptance

- [ ] Confirm the package name, public attribution, npm owner and publishing route for `0.1.0`. Decide whether to enable GitHub private vulnerability reporting.
- [ ] Review the sanitized history before authorizing an update to the public branch. Re-run hosted CI on the resulting release commit.
- [ ] Approve the model and quota for a small real-provider check. Use the [semantic acceptance cases](optimizer-evaluation.md) to review clarity, references, literal material, and scope. Record the selected provider/model and the outcome with synthetic inputs.
- [ ] Review the earlier macOS acceptance against the candidate. Use the [TUI smoke checklist](macos-smoke-test.md) for interactions affected by later changes and any missing coverage. Record the revision, Node, Pi, OS and terminal versions for new checks. Verify the document URLs from the published repository.
- [ ] Decide whether to add a catalog image or video. Pi supports optional `pi.image` and `pi.video` fields. Use a synthetic draft and terminal capture and check the media URL before release. [Pi gallery metadata](https://docs.pi.dev/latest/packages#create-a-package)

## 4. Publish, verify and recover

### Publish interactively for the first time

1. Create a free npm account and verify its email address. The account that publishes the first version will own the unscoped package. Choose a username and public contact email you are comfortable including in package metadata. [Create an npm account](https://docs.npmjs.com/creating-a-new-npm-user-account/) · [About public packages](https://docs.npmjs.com/about-public-packages/)
2. In your npm account settings, enable two-factor authentication for publishing and save the recovery codes privately. [Configure npm 2FA](https://docs.npmjs.com/configuring-two-factor-authentication/)
3. From your terminal, sign in to the public registry and confirm that it shows the account you intend to publish as. Follow the browser prompts opened by `npm login`. [npm login](https://docs.npmjs.com/cli/v11/commands/npm-login/)

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

4. After the owner approves the exact `.tgz` and matching Git ref, publish the reviewed tarball from section 2. Complete the npm authentication prompt. [Publish an unscoped public package](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

   ```sh
   npm publish "$archive" --ignore-scripts --registry=https://registry.npmjs.org/ --access public --tag latest
   ```

### Verify the public package

1. Compare `npm view pi-prompt-refine@0.1.0 dist.integrity --registry=https://registry.npmjs.org/` with the retained pack integrity and confirm `latest` points to `0.1.0`.
2. In a fresh profile, run `pi install npm:pi-prompt-refine@0.1.0`, start Pi, verify `/refine` and the starter Preference, and remove that exact source. Use an isolated native Pi session for this check.
3. Verify the install command, description, repository URL, license and README in the [Pi catalog entry](https://pi.dev/packages/pi-prompt-refine) after indexing. Once the npm version is available, update install instructions in both READMEs. Record the matching tag or GitHub Release if the owner approves creating it.

### Recover from a bad release

For a bad release, stop recommending it, deprecate the affected version if appropriate, and publish a corrected **new** version after review. npm versions are immutable. Users can remove the source shown by `pi list`, then install an earlier known-good version or reviewed Git ref; for the first release, simply removing it disables it after reload. Uninstall is not data erasure: see [history and cleanup](tui-guide.md#local-history-and-cleanup).

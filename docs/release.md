# Publish the native Pi package

Publish the repository root as the native Pi package. Keep the host peers and the bundled starter library JSON required at runtime. Use the [manifest](../package.json) and [pack checker](../scripts/check-pack.mjs) to review the package contents. [Pi package format](https://docs.pi.dev/latest/packages)

## 1. Review the candidate before making it public

- Work from a clean checkout of the exact candidate commit. Check `git status --short`, the root version, lockfile, [changelog](../CHANGELOG.md), MIT notice, repository and issue URLs. Mark the first release as available in both READMEs only when it is available. Pin a version when testing upgrades or rollback.
- Review tracked files and public history, including screenshots, fixtures, experiments, personal paths, session IDs, exports, sidecars, local settings and credentials. Git exposes its history independently of npm's `files` list. Use synthetic examples and keep private experiment output outside the checkout. Run secret scans locally with redacted output. If a credential was exposed, revoke or rotate it at the issuer first. Coordinate any history rewrite with the owner.
- Recheck package name, version, dist-tag, account ownership and 2FA on the public registry. Use `npm view pi-prompt-refine versions --json --registry=https://registry.npmjs.org/` to check whether the name has a visible record. A 404 leaves ownership and availability unverified. Confirm the public npm publisher and copyright attribution. [npm public package publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- Choose interactive publication with 2FA or the tag-triggered workflow using npm trusted publishing. For the interactive route, confirm the active account with `npm whoami --registry=https://registry.npmjs.org/`. [npm trusted publishing and provenance](https://docs.npmjs.com/trusted-publishers/)

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

Use the [pack checker](../scripts/check-pack.mjs) for contents and the [tarball smoke script](../scripts/smoke-pack.sh) for isolated install, load and removal. Manual checks cover terminal input and model behavior. [Earlier candidate evidence](history.md)

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

### Publish a stable release from GitHub Actions

1. In the npm package settings, add a GitHub Actions trusted publisher for user `Steam086`, repository `pi-prompt-refine`, and workflow filename `publish.yml`. Leave Environment name blank and select **Allow npm publish**. Complete the first successful publish within two days of creating the configuration. [npm trusted publishing setup](https://docs.npmjs.com/trusted-publishers/#configuring-trusted-publishing)
2. Set the root package and lockfile to the next version and update the changelog. Review the release commit and confirm its checks pass. Pushing the matching stable tag, such as `v0.1.1`, authorizes publication to npm's `latest` channel.
3. Use the [publish workflow](../.github/workflows/publish.yml) for the exact build and publishing steps. Retain its `npm-package` artifact and `pack.json` for public verification.

### Verify the public package

1. Compare `npm view pi-prompt-refine@<version> dist.integrity --registry=https://registry.npmjs.org/` with the retained pack integrity and confirm `latest` points to the released version.
2. In a fresh profile, run `pi install npm:pi-prompt-refine@<version>`, start Pi, verify `/refine` and the starter Preference, and remove that exact source. Use an isolated native Pi session for this check.
3. Verify the install command, description, repository URL, license and README in the [Pi catalog entry](https://pi.dev/packages/pi-prompt-refine) after indexing. Once the npm version is available, update install instructions in both READMEs. Record the matching tag or GitHub Release if the owner approves creating it.

### Recover from a bad release

For a bad release, stop recommending it, deprecate the affected version if appropriate, and publish a corrected **new** version after review. npm versions are immutable. Users can remove the source shown by `pi list`, then install an earlier known-good version or reviewed Git ref; for the first release, simply removing it disables it after reload. Uninstall is not data erasure: see [history and cleanup](tui-guide.md#local-history-and-cleanup).

# Reporting a security issue

Use [GitHub's private vulnerability report](https://github.com/Steam086/pi-prompt-refine/security/advisories/new) if it is available. If the form is unavailable, open a [GitHub issue](https://github.com/Steam086/pi-prompt-refine/issues) asking for a private reporting channel **without** including the details publicly.

Refine uses Pi's configured provider for rewriting; it has no separate analytics endpoint. Provider retention and the Pi host's own records are outside the extension's control. See [what leaves your machine and what is stored locally](docs/tui-guide.md#what-the-rewrite-provider-receives). Do not attach a session sidecar, Pi profile, `.npmrc`, or private experiment output, even after trimming the visible draft. If a real credential was published, rotate it at the issuer; deleting the current file does not revoke it or erase Git and registry history.

In the private report, include the affected ref or version, the impact, and minimal reproduction steps with synthetic data. Do not include credentials, raw conversations, or Refine history files. Use [the issue tracker](https://github.com/Steam086/pi-prompt-refine/issues) for ordinary bugs.

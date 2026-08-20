# Security policy

Do not place Parley credentials, OAuth codes, bearer tokens, repository remotes, or captured agent content in this repository, generated artifacts, logs, source maps, or test snapshots.

`pnpm scan-secrets` fails closed when it finds credential-like source or generated artifact material and never prints the matched value. Run it before every review and release attempt.

The scanner permits only the documented examples `pn_EXAMPLE_TOKEN`, `pn_PLACEHOLDER_TOKEN`, and `pn_REDACTED_TOKEN`; none is a usable credential.

Before a public release, configure a private reporting channel in the published repository's Security tab. Until that channel exists, do not disclose a suspected vulnerability or credential in a public issue.

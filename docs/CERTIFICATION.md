# Parley plugin certification gate

## Status

The Codex, Claude Code, and Gemini packages are **not published, certified, or generally available**.
This repository can build deterministic local artifacts; it cannot substitute for live host or release
evidence.

## Local artifact evidence

From this repository, run:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm validate
pnpm scan-secrets
node scripts/certify-hosts.mjs --backend-sha <40-lowercase-hex> --plugin-tag v<package-version> --output <local-output-path>
```

The last command validates the three built ZIPs, runs the secret scan and native validators, and writes
an unsigned local inventory of host artifact checksums. It does not sign an artifact, tag a version,
contact a host, mutate a host profile/keychain, create a live OAuth request, deploy, publish, or prove a
release. Keep that local output outside source control.

## Combined report requirement

The backend release verifier accepts a signed report only when it matches the exact backend SHA and
plugin tag/version and is verified against an operator-supplied Ed25519 public key. The report must bind
artifact SHA-256 values; host/version/OS/auth matrix coverage; raw client-id hashes and classification
methods; CIMD safety controls; all six directional pairs with space and revocation behavior; local gate,
privacy, and beta-usability evidence; exact stage/prod SHAs; signature identity; and rollback evidence.
It contains only hashes, classifications, booleans, counts, and bounded timings. Credentials, customer
content, raw client ids, remotes, and paths are prohibited and make the evidence invalid.

## Required external gates

These remain pending until independently completed and recorded:

- stage deployment and schema/legacy installer checks for the exact backend SHA;
- clean-profile OAuth and manual recovery on supported Codex, Claude Code, and Gemini versions across
  Windows, macOS, and Linux, plus a headless/SSH recovery path;
- live OAuth/client-ID/CIMD behavior, including zero pre-session DNS and unsafe-document rejection;
- all six directional cross-agent pairs, with side-effect-free missing space, Git-proven no-remote `main`,
  and isolated connection revocation;
- privacy/usability scans and five first-time external beta testers spanning every host and operating system;
- one immutable tag, signing/checksums, and the three native listings together;
- production promotion/verification for the exact SHA; and
- a rollback exercise that stops issuance/refresh, observes one-hour access-token expiry, preserves host
  credentials and prior artifacts, and leaves additive schema plus legacy `pn_...` support intact.

OAuth copy is limited to a session-start inbox check. It does not promise a per-prompt unread count or
concurrent multi-team routing in one plugin-managed profile.

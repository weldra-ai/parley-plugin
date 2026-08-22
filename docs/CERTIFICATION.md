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

The last command rejects a symlinked or realpath-divergent default local `dist/` root, then snapshots its ZIPs,
checksums, and materialized trees. Validation, the secret scan, native validators, and the inventory hashes all use
those same private snapshot bytes; stable source reads and digest checks reject source or snapshot changes between
every gate and final inventory. It refuses custom artifact directories.
It does not sign an artifact, tag a version, contact a host, mutate a host profile/keychain, create a live
OAuth request, deploy, publish, or prove a release. Keep that local output outside source control.

## Combined report requirement

The backend release verifier accepts a signed report only when it matches the exact backend SHA and
plugin tag/version and is verified against an operator-supplied Ed25519 public key and a separate trusted
copy of the exact candidate `compatibility.json` declaration. Every declared host version in that input must cover
Windows, macOS, Linux, OAuth, and manual authentication, which sets every host-version/OS/auth matrix cell that the
report must cover. The current Windows-only Codex and Gemini input is provisional and is rejected by that release
gate. The report must bind artifact SHA-256 values; raw client-id hashes and
classification methods; CIMD safety controls matched exactly to the CIMD method; all six directional pairs
whose endpoints each bind the declared host/version/OS/auth tuple, exact artifact SHA-256, and exact plugin
tag/version; local gate, privacy, and beta-usability evidence; exact stage/prod SHAs; signature identity; and
rollback evidence.
It contains only hashes, classifications, booleans, counts, and bounded timings. Credentials, customer
content, raw client ids, remotes, and paths are prohibited and make the evidence invalid.

## Required external gates

These remain pending until independently completed and recorded:

- immutable candidate tag plus built/signed checksums first, with the exact compatibility declaration bound
  before clean-profile or pair evidence; this does not publish a package or listing;
- stage deployment and schema/legacy installer checks for the exact backend SHA, followed by candidate
  artifact signature/checksum verification and only reviewed stage issuance flags;
- clean-profile OAuth and manual recovery for every approved compatibility cell; the release declaration must
  cover Codex, Claude Code, and Gemini across Windows, macOS, and Linux, plus a headless/SSH recovery path;
- live OAuth/client-ID/CIMD behavior, including zero pre-session DNS and unsafe-document rejection;
- all six directional cross-agent pairs bound to those exact candidate artifacts, with side-effect-free
  missing space, Git-proven no-remote `main`, and isolated connection revocation;
- privacy/usability scans and five first-time external beta testers spanning the approved coverage;
- production promotion/verification for the exact SHA;
- a rollback exercise that stops issuance/refresh, observes one-hour access-token expiry, preserves host
  credentials and prior artifacts, and leaves additive schema plus legacy `pn_...` support intact; and
- only then publication of the artifacts and all three native listings after the stage matrix and release
  signature are accepted.

OAuth copy is limited to a session-start inbox check. It does not promise a per-prompt unread count or
concurrent multi-team routing in one plugin-managed profile.

# Parley agent plugins

This public repository exists as the canonical source for Parley packages targeting Codex, Claude Code, and Gemini CLI. Native catalog metadata is prepared here, but no release tag, listing, or published release exists yet. The packages are not yet available; see [docs/CERTIFICATION.md](docs/CERTIFICATION.md) for the gates that must be completed first.

## Planned installation

These are the exact public install paths reserved for the first signed release. They are **not yet available** until the matching tag passes the release gate.

Codex:

```text
codex plugin marketplace add weldra-ai/parley-plugin --ref v0.1.0
codex plugin add parley@weldra
```

Claude Code:

```text
claude plugin marketplace add weldra-ai/parley-plugin@v0.1.0
claude plugin install parley@weldra
```

Gemini CLI:

```text
gemini extensions install https://github.com/weldra-ai/parley-plugin --ref v0.1.0 --skip-settings
```

All three packages connect directly to `https://parley.weldra.dev/mcp`. OAuth is the default; the one-time manual token flow is recovery-only. Gemini 0.56.0 may report that the recovery-only `Parley token` setting is missing after `--skip-settings`; that warning is expected and does not block OAuth.

## Layout

- `hosts/` contains host-native manifests and host-only files.
- `shared/` contains content staged into every artifact.
- `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json` are the native catalogs.
- `plugins/` contains committed Codex and Claude install snapshots generated from `hosts/` plus `shared/`; never edit those snapshots by hand.
- `dist/` is generated locally and is never committed.

## Local gates

Run these commands with Node 20 or later and pnpm 11.6.0:

```text
pnpm install --frozen-lockfile
pnpm sync-marketplaces
pnpm test
pnpm build
pnpm validate
pnpm scan-secrets
node scripts/certify-hosts.mjs --backend-sha <40-lowercase-hex> --plugin-tag v<package-version> --output <local-output-path>
```

`SOURCE_DATE_EPOCH` controls ZIP entry timestamps. When it is absent, the build uses the ZIP epoch so the output remains reproducible.

The build produces three versioned ZIP artifacts, their SHA-256 checksum files, and materialized native roots in `dist/`. The package version is the one source of artifact version truth. `pnpm sync-marketplaces` refreshes the two committed Git-install snapshots; `pnpm validate` rejects any snapshot or catalog drift. `pnpm prepare-release` copies the three canonical archives into `release/` and adds byte-identical `darwin.parley.zip`, `linux.parley.zip`, and `win32.parley.zip` Gemini aliases so GitHub Releases selects the right extension asset without mistaking the Codex or Claude archives for Gemini.

`certify-hosts.mjs` rejects a symlinked or realpath-divergent `dist/` root, snapshots the default local archives
and materialized trees, and detects source or snapshot changes while it validates, secret-scans, native-validates,
and hashes those same private snapshot bytes before writing an **unsigned local artifact inventory**. It refuses
custom artifact directories. It does not authenticate a host, create a
real signed report, or satisfy the required stage, production, cross-agent, beta, signing, publication, or
rollback gates.

## Candidate and release signing

The release workflow accepts only an annotated `candidate/v${package.version}-r${package.releaseCandidate}` or `v${package.version}` tag signed by the configured public key. Incrementing `package.releaseCandidate` preserves rejected immutable candidates without changing the eventual public package version. A candidate tag builds the exact release artifacts and stores them in an unpublished draft GitHub Release. The final tag must point to the same commit as its signed candidate tag; the workflow rebuilds that commit, requires a byte-for-byte match with the draft assets, and publishes those candidate assets.

Before creating either tag, an active repository tag ruleset with no bypass actors must prevent updates and deletions for `candidate/v*` and `v*`. The draft is visible to users with push access, but it is not a published release or native marketplace listing.

Before enabling either path, add these repository **Variables** (not secrets):

- `PARLEY_RELEASE_SIGNER_PUBLIC_KEY`: public verification key material only (ASCII-armored); it must not contain private-key material.
- `PARLEY_RELEASE_SIGNER_FINGERPRINT`: the authorized primary-key fingerprint (40-character v4 or 64-character v5 hexadecimal); whitespace and case are normalized before an exact comparison.

The workflow imports that public key into an isolated temporary GnuPG home, rejects any imported private-key record or anything other than exactly one primary fingerprint, requires that fingerprint to match, and then runs `git verify-tag`. Never store private-key material in this repository, its variables, or GitHub Actions.

## Compatibility status

`compatibility.json` records provisional tested-version, operating-system, and authentication declaration
inputs plus enforcement posture. It is not host-version certification or release evidence. The current Windows-only
Codex and Gemini declarations cannot authorize the release verifier: an operator-trusted candidate must declare
Windows, macOS, Linux, OAuth, and manual authentication for every supported host version before the signed backend
report can cover every required matrix cell.

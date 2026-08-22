# Parley agent plugins

This repository is the canonical source for Parley packages targeting Codex, Claude Code, and Gemini CLI. It is a local scaffold only: no marketplace entry, remote, or published release is created here. The packages are not yet available; see [docs/CERTIFICATION.md](docs/CERTIFICATION.md) for the gates that must be completed first.

## Layout

- `hosts/` contains host-native manifests and host-only files.
- `shared/` contains content staged into every artifact.
- `dist/` is generated locally and is never committed.

## Local gates

Run these commands with Node 20 or later and pnpm 11.6.0:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm validate
pnpm scan-secrets
node scripts/certify-hosts.mjs --backend-sha <40-lowercase-hex> --plugin-tag v<package-version> --output <local-output-path>
```

`SOURCE_DATE_EPOCH` controls ZIP entry timestamps. When it is absent, the build uses the ZIP epoch so the output remains reproducible.

The build produces three versioned ZIP artifacts, their SHA-256 checksum files, and materialized native roots in `dist/`. The package version is the one source of artifact version truth.

`certify-hosts.mjs` snapshots the default local `dist/` archives and materialized trees, then validates,
secret-scans, native-validates, and hashes those same private snapshot bytes before writing an **unsigned
local artifact inventory**. It refuses custom artifact directories. It does not authenticate a host, create a
real signed report, or satisfy the required stage, production, cross-agent, beta, signing, publication, or
rollback gates.

## Release signer configuration

The release workflow accepts only an annotated `v${package.version}` tag signed by the configured public key. Before enabling releases, add these repository **Variables** (not secrets):

- `PARLEY_RELEASE_SIGNER_PUBLIC_KEY`: public verification key material only (ASCII-armored); it must not contain private-key material.
- `PARLEY_RELEASE_SIGNER_FINGERPRINT`: the authorized primary-key fingerprint (40-character v4 or 64-character v5 hexadecimal); whitespace and case are normalized before an exact comparison.

The workflow imports that public key into an isolated temporary GnuPG home, rejects any imported private-key record or anything other than exactly one primary fingerprint, requires that fingerprint to match, and then runs `git verify-tag`. Never store private-key material in this repository, its variables, or GitHub Actions.

## Compatibility status

`compatibility.json` records provisional tested-version, operating-system, and authentication declaration
inputs plus enforcement posture. It is not host-version certification or release evidence. Before external
release certification, an operator-trusted copy of the exact candidate declaration sets every matrix cell the
signed backend report must cover.

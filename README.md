# Parley agent plugins

This repository is the canonical source for Parley packages targeting Codex, Claude Code, and Gemini CLI. It is a local scaffold only: no marketplace entry, remote, or published release is created here.

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
```

`SOURCE_DATE_EPOCH` controls ZIP entry timestamps. When it is absent, the build uses the ZIP epoch so the output remains reproducible.

The build produces three versioned ZIP artifacts, their SHA-256 checksum files, and materialized native roots in `dist/`. The package version is the one source of artifact version truth.

## Release signer configuration

The release workflow accepts only an annotated `v${package.version}` tag signed by the configured public key. Before enabling releases, add these repository **Variables** (not secrets):

- `PARLEY_RELEASE_SIGNER_PUBLIC_KEY`: public verification key material only (ASCII-armored); it must not contain private-key material.
- `PARLEY_RELEASE_SIGNER_FINGERPRINT`: the authorized primary-key fingerprint (40-character v4 or 64-character v5 hexadecimal); whitespace and case are normalized before an exact comparison.

The workflow imports that public key into an isolated temporary GnuPG home, rejects any imported private-key record or anything other than exactly one primary fingerprint, requires that fingerprint to match, and then runs `git verify-tag`. Never store private-key material in this repository, its variables, or GitHub Actions.

## Compatibility status

`compatibility.json` records only the supported host surface and its enforcement posture. It intentionally makes no host-version certification claim until the host-specific tasks complete live validation.

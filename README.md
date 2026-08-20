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

## Compatibility status

`compatibility.json` records only the supported host surface and its enforcement posture. It intentionally makes no host-version certification claim until the host-specific tasks complete live validation.

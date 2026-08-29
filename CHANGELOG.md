# Changelog

## Unreleased

- Prepared the private r3 candidate source with one pinned version per host and a complete 18-cell
  Windows/macOS/Linux by OAuth/manual compatibility declaration. This is a release input, not certification evidence.
- Made validation reject empty tested-version lists or incomplete operating-system and authentication declarations.
- Fixed Windows Codex manual recovery validation so the resolved command shim executes through the
  trusted command processor instead of failing closed on Node argument escaping.
- Scaffolded deterministic, multi-host Parley artifact builds.
- Added local-only artifact inventory and release-gate documentation. This does not publish, certify,
  or make the packages available.
- Hardened local inventory evidence around one private artifact snapshot, stable source-tree identity checks, and
  compatibility-bound release gates.
- Added deterministic Codex and Claude marketplace snapshots plus platform-selectable Gemini release aliases.

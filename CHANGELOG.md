# Changelog

## Unreleased

- Fixed Windows Codex manual recovery validation so the resolved command shim executes through the
  trusted command processor instead of failing closed on Node argument escaping.
- Scaffolded deterministic, multi-host Parley artifact builds.
- Added local-only artifact inventory and release-gate documentation. This does not publish, certify,
  or make the packages available.
- Hardened local inventory evidence around one private artifact snapshot, stable source-tree identity checks, and
  compatibility-bound release gates.
- Added deterministic Codex and Claude marketplace snapshots plus platform-selectable Gemini release aliases.

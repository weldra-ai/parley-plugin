# Codex plugin contract validator provenance

`validate_plugin.py` is a repository-carried copy of the Codex `plugin-creator` validator at `scripts/validate_plugin.py`, captured on 2026-08-21. Its only transformation is LF line-ending normalization required by this repository's `.gitattributes`; its logic is otherwise unmodified.

- Source SHA-256 (original CRLF bytes): `4e84c911479e4d158d723ed8ccc881d3499e580fbf5650e60d379a1a25ac3186`
- Vendored SHA-256 (repository LF bytes): `ebda00d55d7518b127f675f062fb5c6e7a1ffdc0a99df1a55ac594400d7d3228`
- Python dependency: `PyYAML==6.0.2` in `requirements.txt`
- Scope: portable Codex plugin ingestion-contract validation only. It is not a live Codex host-certification claim.

Claude and Gemini use their pinned vendor CLIs through `pnpm validate`. Every native validator is required; a missing command or non-zero result fails the gate.

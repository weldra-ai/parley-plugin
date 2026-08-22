# Parley for Codex

Install Parley through its Codex plugin distribution, then begin a Codex session in a repository.
The bundled HTTP server has no static credential, so Codex uses its native OAuth flow when Parley
challenges the connection.

If OAuth is unavailable, run the manual command from a private interactive terminal in the installed
artifact:

```powershell
.\scripts\connect-manual.ps1
```

```sh
sh ./scripts/connect-manual.sh
```

The wrapper reads the token without echoing it and passes it only over standard input to the shared
manager. The manager writes one exact owner-marked contiguous block to the selected Codex
`config.toml`: a same-name `parley` override with the canonical MCP URL and one bearer header. It
refuses every unowned Parley configuration form and preserves every byte outside that managed manual
override. Re-running the manual command does not duplicate the server.

To remove only the managed manual override and restore the bundled OAuth server, use the exact
rollback switch:

```powershell
.\scripts\connect-manual.ps1 -OAuth
```

```sh
sh ./scripts/connect-manual.sh --oauth
```

The manager uses `CODEX_HOME/config.toml` when `CODEX_HOME` is set; otherwise it uses
`~/.codex/config.toml`. It creates owner-private staged files, atomically promotes the configuration,
and removes staged credential files after success or rollback. On Windows the staging file is hardened
to the current user's ACL before the token is written; this gives atomic visibility and in-process
rollback, not a power-loss durability guarantee.

Parley does not register an authenticated Codex lifecycle hook in this release. Codex hook credential
recovery and a Git-proven repository-root input were not certified together, so the quiet session-start
behavior is retained. The shared Parley skill resolves repository space explicitly after a `SPACE_REQUIRED` control
result; do not guess `main` without Git proof that the repository has no remotes.

Windows 0.148.0 artifact and disposable-profile checks are recorded for this release. macOS and Linux
host certification remains a Task 14 matrix responsibility.

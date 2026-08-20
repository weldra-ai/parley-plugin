# Parley for Claude Code

Install Parley through its Claude Code plugin distribution, then start a new Claude Code session in a
repository. By default, Parley uses Claude Code's OAuth flow.

If OAuth is unavailable, run the manual command from a private interactive terminal in the installed
artifact. It reads the token without echoing it and installs one user-scope override for the same
Parley endpoint:

```powershell
.\scripts\connect-manual.ps1
```

```sh
sh ./scripts/connect-manual.sh
```

The manager sends the token only over standard input, stores it only in Claude Code's user profile,
and keeps a checksum-verified copy of the space helper beside that profile. It uses
`CLAUDE_CONFIG_DIR` when set; otherwise Claude's default config is `~/.claude.json` and the managed
helper lives under `~/.claude/parley`. It refuses to overwrite a conflicting same-endpoint entry.

To remove only the owned manual override and return to OAuth, run:

```powershell
.\scripts\connect-oauth.ps1
```

```sh
sh ./scripts/connect-oauth.sh
```

The plugin derives the Parley space from the repository's unambiguous `origin` remote. A repository
with no remotes uses `main`. Missing Git metadata, ambiguous remotes, and non-repository directories
send no `X-Space` header, so Parley returns its normal context-required result rather than guessing.

On older Claude Code versions that do not invoke `headersHelper`, the first space-aware Parley tool call
can return `SPACE_REQUIRED`. This is a side-effect-free control result: resolve the Git context, retry
that same call with explicit `space` set to the raw unambiguous origin (or proven `main`), and use that
explicit space on later space-aware calls in the session. Ambiguous Git must never retry and must
not be replaced with a guessed space.

The SessionStart hook only reminds Claude Code that Parley is available. It does not inspect the inbox
or send the manual token to a hook process.

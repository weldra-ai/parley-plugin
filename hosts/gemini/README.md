# Parley for Gemini CLI

Install Parley as a Gemini CLI extension. The one bundled `parley` server is OAuth-enabled and has one
sensitive recovery setting named `PARLEY_TOKEN`.

Use `--skip-settings` on the initial install so Gemini does not ask for the recovery token before trying
OAuth. Gemini CLI 0.56.0 still prints `missing settings: Parley token`; that warning is expected and does
not disable the extension or block OAuth. Configure the setting only when the OAuth flow is unavailable.

With no sensitive setting stored, Gemini CLI 0.56.0 first sends `Authorization: Bearer`, receives the
normal 401 challenge, and continues OAuth discovery. A valid stored OAuth credential overrides the recovery-only manual header. This is not a persistent auth-mode switch: Gemini 0.56.0 exposes no
credential-clear or no logout command, so the release does not promise a switch away from
successful OAuth.

For recovery only, run the installed wrapper from a private interactive terminal:

```powershell
.\scripts\connect-manual.ps1
```

```sh
sh ./scripts/connect-manual.sh
```

The wrapper launches exactly this Gemini-owned sensitive-setting UI and never reads, accepts,
forwards, or writes the token itself:

```text
gemini extensions config parley PARLEY_TOKEN --scope user
```

The host stores this sensitive setting in its native operating-system keychain. The extension manifest
and settings artifacts retain only the `${PARLEY_TOKEN}` substitution; do not create an extension `.env`
file for the token.

Parley does not register a Gemini authenticated lifecycle hook in this release. Gemini hook credential
propagation and a Git-proven repository-root input were not certified together, so quiet session-start
behavior is retained. The shared Parley skill resolves repository space explicitly after `SPACE_REQUIRED`; it must not
guess `main` without Git proof that the repository has no remotes.

Gemini CLI 0.56.0 validation and loopback transport evidence are Windows-only for this release. macOS
and Linux host certification remains a Task 14 matrix responsibility.

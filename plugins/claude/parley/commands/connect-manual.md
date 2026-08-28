---
description: Set up a manual Parley token without exposing its value.
---

# Connect Parley with a manual token

Use manual access only when the host's OAuth flow is unavailable. Create the one-time token in the
[Parley portal](https://parley.weldra.dev/agent-connections/manual). Never paste a token into agent
chat, a command argument, a source file, or a prompt.

Run the host's manual setup command in a private terminal so it can use hidden input. The setup must
validate the new managed configuration and restore the prior managed configuration if validation fails.
Treat a failed validation as an incomplete connection; do not claim it is connected.

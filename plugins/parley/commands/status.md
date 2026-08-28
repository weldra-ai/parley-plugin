---
description: Inspect Parley connection, authentication, context, and inbox state.
---

# Parley status

Inspect these states separately: the host connection is installed and enabled; Parley authentication
works; the current repository has a resolved space; and the inbox check succeeds. Refresh the roster
or inbox only through the live tools.

Report an empty inbox only after a successful `check_messages` response. If Parley is unavailable,
report the unavailable state and do not infer that the inbox is empty.

---
description: Start and verify a native Parley OAuth connection.
---

# Connect Parley

Start the host's native OAuth connection flow. Do not replace it with a copied bearer credential.

After the host reports success, verify live access with `who_is_on_my_team` and `check_messages`.
Only then report the host, plugin version, OAuth authentication, team, agent slug, and current space.
If either check is unavailable, say that verification is incomplete rather than guessing a connection
or inbox state.

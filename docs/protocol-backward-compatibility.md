---
metadata:
  change-policy: >-
    Changes require a separate documentation-only pull request for review and
    approval. The recommended reviewer is taowen-paraflow.
---

# Protocol backward compatibility

Mobius protocol releases must support rolling upgrades in which deployed services,
local Runtimes, SDK clients, and persisted messages temporarily use adjacent
versions.

## Compatibility rules

- Adding a field to an existing object is compatible. Receivers validate every
  field they understand and ignore unrecognized fields.
- A receiver must continue to accept an older representation that omits a newly
  introduced field. The new field must have an explicit fallback until all
  supported senders provide it.
- Adding a message kind is compatible on long-lived transports. A receiver logs a
  bounded warning and skips an unrecognized kind without closing the connection.
- A recognized message kind with an invalid known field remains a protocol error.
  Compatibility must not weaken validation of supported representations.
- Removing or changing the meaning, type, or validation of an existing field or
  message kind requires a new versioned representation or negotiated capability.
- A sender must not require an unnegotiated new response from an older peer.

## Delivery requirements

Every protocol change must include a contract scenario for mixed-version behavior.
At minimum, additive fields and message kinds must prove that an older peer can
continue using the connection, while a newer receiver must prove that the previous
representation still receives its documented fallback.

When a change cannot satisfy these rules, introduce a versioned message or an
explicitly negotiated capability and deploy receiver support before enabling the
new sender behavior.

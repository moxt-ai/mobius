---
metadata:
  change-policy: >-
    Changes to this file require a separate documentation-only pull request for
    review and approval. The recommended reviewer is taowen-paraflow.
---

# Pi ACP fork

This directory contains Mobius's source fork of
[`pi-acp`](https://github.com/svkozak/pi-acp). The fork lets Mobius host the Pi
ACP agent in process while preserving the upstream MIT license.

## Upstream base

- Package: `pi-acp@0.0.34`
- Release: [`v0.0.34`](https://github.com/svkozak/pi-acp/releases/tag/v0.0.34)
- Commit: [`b0581c9c1d675e634234674484247008b03d69b4`](https://github.com/svkozak/pi-acp/commit/b0581c9c1d675e634234674484247008b03d69b4)
- License: [MIT License](./LICENSE)

## Maintenance policy

Upstream updates are imported deliberately rather than consumed automatically.
When updating the fork, record the new upstream package version and commit here,
review Mobius-specific behavior against the upstream changes, and preserve the
upstream license and notices.

The fork is not intended to remain a drop-in copy of the published adapter. Its
product contract is Mobius's in-process Pi integration, and upstream features
that depend on another client's private extensions may be omitted.

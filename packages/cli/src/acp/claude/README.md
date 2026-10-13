---
metadata:
  change-policy: >-
    Changes to this file require a separate documentation-only pull request for
    review and approval. The recommended reviewer is taowen-paraflow.
---

# Claude ACP fork

This directory contains Mobius's source fork of
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp).
The fork lets Mobius host the Claude ACP agent in process while preserving the
upstream Apache-2.0 license.

## Upstream base

- Package: `@agentclientprotocol/claude-agent-acp@0.73.0`
- Release: [`v0.73.0`](https://github.com/agentclientprotocol/claude-agent-acp/releases/tag/v0.73.0)
- Commit: [`ea7076c0bc324603e65d8c124b7573f158749969`](https://github.com/agentclientprotocol/claude-agent-acp/commit/ea7076c0bc324603e65d8c124b7573f158749969)
- License: [Apache License 2.0](./LICENSE)

## Maintenance policy

Upstream updates are imported deliberately rather than consumed automatically.
When updating the fork, record the new upstream package version and commit here,
review Mobius-specific behavior against the upstream changes, and preserve the
upstream license and notices.

The fork is not intended to remain a drop-in copy of the published adapter. Its
product contract is Mobius's in-process Claude integration, and upstream
features that depend on another client's private extensions may be omitted.

---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Contributing to Mobius

This guide is for developing Mobius itself. To integrate Mobius into your own
application, start with the [README](../README.md#start-with-the-sdk).

## Set up your development environment

Use the Node and pnpm versions in [`.nvmrc`](../.nvmrc) and
[`package.json`](../package.json). From the repository root, install dependencies:

```sh
pnpm install
```

Read [AGENTS.md](AGENTS.md) for the engineering and contribution rules before making
changes. When working with a coding Agent, provide docs/AGENTS.md as repository
instructions; the Claude entrypoint is docs/CLAUDE.md. See [DEVELOPMENT.md](DEVELOPMENT.md) for design and deployment guidance.

## Run locally

Start the local Platform Worker:

```sh
pnpm dev
```

Committed migrations define fresh local databases. The following command generates
ignored SQL import modules used by the Worker and tests:

```sh
pnpm db:codegen
```

For an integration workflow that pairs an isolated Runtime and exercises sessions
without Morty, follow the [mini-client walkthrough](../packages/mini-client/README.md).

## Verify your changes

For routine development, run static checks and the tests related to your change:

```sh
pnpm lint
pnpm typecheck
```

Use [TESTING.md](TESTING.md) to select the appropriate test suite and prepare its
prerequisites. It distinguishes controlled boundary tests from compatibility checks
using real Agent executables and adapters.

To run the test suites or build the project:

```sh
pnpm test
pnpm build
```

Before submitting a pull request, follow the scope, documentation separation, package
versioning, and PR title requirements in [AGENTS.md](AGENTS.md). Include the relevant
verification results and any limitations so reviewers can assess the change.

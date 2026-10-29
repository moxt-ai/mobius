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

## Issues and pull requests

Read this guide before opening an issue or pull request.

Compatibility is mandatory unless the human user or maintainer explicitly requires
the particular breaking change. Follow the engineering rules and
[CODE_REVIEW.md](CODE_REVIEW.md). For a changed external contract, include the
affected peers, both mixed-version verification results, and rollout/recovery
consequences in the PR; cite the explicit instruction for any intentional break.

- Write issue titles and descriptions in English.
- Write pull request titles and descriptions in English.
- Write code comments in English.
- Format pull request titles as Conventional Commits:
  `<type>(<optional-scope>): <imperative summary>`. Omit the parentheses when
  no scope is needed, for example `chore: update dependencies`.
- Describe the problem, expected behavior, and relevant reproduction steps in
  issues. For feature requests, describe the user need and desired outcome.
- In pull requests, explain the change, link related issues, and include relevant
  verification results and any limitations.
- Keep Markdown changes in documentation-only pull requests, separate from code,
  configuration, dependencies, and submodule updates.

## Set up your development environment

Use the Node and pnpm versions in [`.nvmrc`](../.nvmrc) and
[`package.json`](../package.json). From the repository root, install dependencies:

```sh
pnpm install
```

Read [AGENTS.md](AGENTS.md) for the engineering and contribution rules before making
changes. When working with a coding Agent, provide docs/AGENTS.md as repository
instructions; the Claude entrypoint is docs/CLAUDE.md. Design and deployment
constraints are included below.

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
without Morty, follow the [SDK session example](../packages/mobius-sdk/README.md#run-the-complete-session-example).

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
versioning, and engineering requirements in [AGENTS.md](AGENTS.md). Include the relevant
verification results and any limitations so reviewers can assess the change.

## Design rationale

The [product goals](../README.md#why-mobius-exists) explain why the system exists.
Implementation choices must serve those goals without turning the README into a
second protocol specification.

ACP supplies client-to-Agent interaction. Using it does not by itself prove that a
user can securely reach their machine remotely, switch devices, see another client's
prompt or recover after disconnecting. Mobius must provide those user experiences
while reusing the Agent's operations rather than inventing parallel semantics.

Current-turn recovery is difficult because a user may return while work is still
changing, before native history contains the result. Execution completion, delivery
and history availability must remain separate. The daemon owns the current execution
view. Rejoining should show available content and resume live updates. History
handoff must not duplicate or remove content already displayed, but recovery cannot
promise to reconstruct events lost during disconnects or restarts. The concrete
transitions and recovery algorithm belong in code and boundary tests.

## Database operations

Generate migrations using the pinned `db:generate:*` commands in
[package.json](../package.json). `pnpm db:codegen` prepares ignored SQL modules for
build targets that cannot import SQL directly. Committed migrations are immutable.

Deployment workflows apply D1 migrations before deploying their consuming Workers.
Configure `CLOUDFLARE_D1_API_TOKEN` with D1 Edit separately from the deployment
`CLOUDFLARE_API_TOKEN`; both use the environment's `CLOUDFLARE_ACCOUNT_ID`.
See the workflows for exact environment bindings and failure gates.

## Persistence and recovery constraints

Pairing credentials, connection preferences and session metadata may be retained
locally. Agents own their native history. Current-turn content and pending prompt
bodies remain in daemon memory. The daemon
may persist bounded execution receipts without prompt content to distinguish work
interrupted by a restart from work that completed before disconnecting. A restart
does not resume work automatically: the application owns continuation policy and
submits any continuation as a new command. Commands that already started must not
execute again when their identifiers are replayed after a restart; commands that
never started may be resubmitted. Local diagnostics must not contain prompt text
or become an event archive.

Live delivery must not depend on acknowledgements, persistent delivery queues or
retries. Optional cloud Recording is best effort and must never block live output.
Without Recording, access to saved history depends on the connected machine and
its Agent. Recording does not guarantee a complete archive.

These are product constraints, not claims that every implementation currently
satisfies them. Resolve a conflict by correcting the implementation or proposing a
separate constraint change; do not rewrite the constraint to match an accidental
implementation. Exact schemas and recovery algorithms belong in executable code.

## Image delivery constraints

Users should see images without large base64 payloads delaying live text or opening
a conversation. Images embedded in structured Agent output must become local image
references before entering live delivery or history responses. Clients fetch the
image from the connected machine through the existing authorized file-read path.
The same rule applies to images nested inside tool results; copying their encoded
bytes into a tool's JSON display defeats this purpose.

The daemon may decode embedded images into a private temporary cache, naming files
by a hash of the decoded bytes. This is an exception for media delivery, not Session
persistence. Identical decoded content must reuse the same file. The cache has no
capacity limit, but must release expired files and validate image data and file
access locally. A hash is not authorization.
Eviction or a restart may make an image unavailable; native history can recreate it
when the Agent retained the original. Recording does not guarantee offline access
to these temporary images.

Failure to prepare an image must be visible as unavailable media and must not stop
text delivery or execution. Ordinary text that happens to contain base64 remains
text; it must not be guessed to be an image or silently rewritten.

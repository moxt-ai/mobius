---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Development

See [AGENTS.md](AGENTS.md) for engineering rules, [README.md](README.md) for setup
and hosting, and [TESTING.md](TESTING.md) for verification.

## Design rationale

The [product goals](README.md#why-mobius-exists) explain why the system exists.
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
[package.json](package.json). `pnpm db:codegen` prepares ignored SQL modules for
build targets that cannot import SQL directly. Committed migrations are immutable.

Deployment workflows apply D1 migrations before deploying their consuming Workers.
Configure `CLOUDFLARE_D1_API_TOKEN` with D1 Edit separately from the deployment
`CLOUDFLARE_API_TOKEN`; both use the environment's `CLOUDFLARE_ACCOUNT_ID`.
See the workflows for exact environment bindings and failure gates.

## Persistence and recovery constraints

Pairing credentials, connection preferences and session metadata may be retained
locally. Agents own their native history. Current-turn content, pending prompts and
execution state must remain in daemon memory; a restart loses them by design and
does not resume work. Local diagnostics may be retained for troubleshooting, but
must not contain prompt text or become an event archive.

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

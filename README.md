<div align="center">

# Mobius

**English** · [简体中文](README.zh-CN.md)

### Build on the coding Agents your users already use.

SDK and infrastructure for remote access to Agents on users' machines.

[Start building](packages/mobius-sdk/README.md#start-building) · [Contributing](docs/CONTRIBUTING.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@moxt-ai/mobius-sdk.svg?label=%40moxt-ai%2Fmobius-sdk)](https://www.npmjs.com/package/@moxt-ai/mobius-sdk)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19.0-111.svg)](https://nodejs.org)

<img src="docs/assets/readme-accent.svg" width="320" height="40" alt="" />

</div>

Add coding Agent sessions to your application, with live output, remote instructions,
and shared conversation views. Mobius handles Agent connectivity while your users
keep their projects, tools, and native development environments.

## Why Mobius exists

- **One integration across Agents.** Use a shared TypeScript SDK instead of building
  remote access and session interaction separately for each Agent.
- **Work on the user's machine.** Connect to the environment where their code,
  tools, and Agent history already live.
- **Turn ongoing work into a shared experience.** Stream replies to multiple clients,
  send follow-up instructions, stop execution, and respond to supported permission requests.

## Your Cloudflare account. Or ours.

Deploy Mobius to **your own Cloudflare account, including the Free plan**, or use
our **free hosted service**. Both options run on Cloudflare's global network.
Your application can automatically select a project's region from user location.
Mobius uses that selection for project routing, helping keep shared work closer to
its audience. Cloudflare provides nearby edge entry points and places compute
according to the regional preference.

Regional options include North America, Europe, Asia-Pacific (including northeast
and southeast Asia), and Oceania. Our hosted storage is configured in
**Asia-Pacific and western North America**.

<a id="data-ownership-and-recovery"></a>

## Your history. Your choice.

Keep Agent history on the connected machine, or enable optional cloud Recording
for access to recorded history while that machine is offline. Choose the balance of
privacy and availability that fits your application.

Recording is **off by default**. It resolves per project, then per application, then
to the system default of `disabled`, and it also requires a deployed provider. A
provider binding on its own does not turn it on. When Recording is enabled, stored
session envelopes can contain prompts, assistant messages, and tool inputs and
outputs, including file content emitted by tools. Decide deliberately, and tell your
users what you chose.

[Explore history and storage options →](packages/mobius-sdk/README.md#history-and-reconnects)

## From your application to their machine

```text
Your application  →  Mobius SDK  →  Relay  →  Local daemon  →  Coding Agent
```

You own the interface and access policies. Agent execution stays on the connected
machine, where local actions are authorized. Available capabilities depend on the Agent
and its configuration.

## Security model

Worth being explicit about, because it determines what Mobius can and cannot promise:

- **Execution is local.** The Agent runs on the user's machine under their own
  operating-system account. Mobius routes instructions and output; it does not
  execute code on their behalf.
- **The relay is trusted, not blind.** Session traffic passes through the relay in a
  form the relay can process. **Mobius is not end-to-end encrypted.** If your product
  needs E2EE, Mobius does not provide it today — deploy the relay into your own
  Cloudflare account if you need the trusted component to be you.
- **Identity is per machine.** A connected machine's identity lives in that user's
  local application data directory, protected by filesystem permissions, and is
  never synced across machines.
- **Access is grantable and revocable.** Sharing hands over the ability to view and
  control sessions in a project. Revocation is a first-class operation, scoped to
  the project saved in a machine's local configuration.

Reporting a vulnerability: see [SECURITY.md](SECURITY.md). Please don't open a
public issue for a security problem.

## Requirements

- **Node.js 20.19.0 or newer** for `@moxt-ai/mobius-sdk`; the `@moxt-ai/mobius` CLI needs **22.19.0 or newer**
- For self-deployment, a Cloudflare account (the Free plan is enough to start)
- Contributing to this repository needs the version pinned in `.nvmrc`

## Built with Mobius

[**Morty**](https://github.com/moxt-ai/morty) — a browser client for remote coding Agent
conversations, live replies, and history, built on Mobius.

<a id="start-with-the-sdk"></a>

---

## Start building

```sh
npm install @moxt-ai/mobius-sdk
```

**[Read the SDK README →](packages/mobius-sdk/README.md#start-building)**

Set up your connection, run your first SDK request, and follow the complete Session example.

Want to improve Mobius? Read the [contribution guide](docs/CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

Packages published before this license was adopted carry `ISC` in their metadata;
those published versions remain available under the license they shipped with.

"Mobius" and "Moxt", and the Mobius and Moxt logos, are trademarks of Moxt. The
Apache 2.0 license grants you rights to the code, not to the names or marks — a
fork is welcome, but please give it a name of its own.

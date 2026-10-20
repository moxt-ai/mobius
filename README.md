<div align="center">

# Mobius

**English** · [简体中文](README.zh-CN.md)

### Build on the coding Agents your users already use.

SDK and infrastructure for remote access to Agents on users' machines.

[Start building](docs/GUIDE.md#start-with-the-sdk) · [SDK reference](packages/mobius-sdk/README.md) · [Contributing](docs/CONTRIBUTING.md)

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

[Explore history and storage options →](docs/GUIDE.md#data-ownership-and-recovery)

## From your application to their machine

```text
Your application  →  Mobius SDK  →  Relay  →  Local daemon  →  Coding Agent
```

You own the interface and access policies. Agent execution stays on the connected
machine, where local actions are authorized. Available capabilities depend on the Agent
and its configuration.

## Built with Mobius

[**Morty**](https://github.com/moxt-ai/morty) — a browser client for remote coding Agent
conversations, live replies, and history, built on Mobius.

<a id="start-with-the-sdk"></a>

---

## Start building

```sh
npm install @moxt-ai/mobius-sdk
```

**[Follow the integration guide →](docs/GUIDE.md#start-with-the-sdk)**

Set up your connection and make your first SDK request. See the
[SDK reference](packages/mobius-sdk/README.md) for browser and server integration.

Want to improve Mobius? Read the [contribution guide](docs/CONTRIBUTING.md).

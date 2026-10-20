<div align="center">

# Mobius

### Bring coding Agents into your product.

SDK and infrastructure for connecting applications to coding Agents on users' machines.

[SDK](packages/mobius-sdk/README.md) · [Integration guide](GUIDE.md) · [Platform](https://mobius.moxt.ai/) · [Contributing](CONTRIBUTING.md)

</div>

Your users already have coding Agents, projects, and tools on their computers.
Mobius lets you build applications around that work: discover Agents, interact with
sessions, stream results, and bring people into the loop through a shared TypeScript SDK.

**Build the experience. Mobius connects it to the Agent.**

## Why Mobius exists

Adding remote Agent interaction to a product means more than sending a prompt. You
need to reach the user's machine, adapt different Agents, follow ongoing work, and
route instructions and permission responses back to the right session.

Mobius provides that foundation so you can focus on what makes your application useful.

- **Integrate across Agents.** Build against a shared SDK for discovery, sessions,
  settings, and interaction instead of implementing remote access for each Agent.
- **Work where the project lives.** Agents use their existing models, tools, and
  native development environments on the connected machine.
- **Make ongoing work visible.** Stream output as it grows, let multiple clients
  watch the same conversation, and show instructions sent from elsewhere.
- **Keep users involved.** Send instructions, queue follow-up work, stop execution,
  and handle permission requests where the Agent supports them.
- **Own your application.** Choose your interface and access policies, and integrate
  Mobius from browser or server clients without adopting a particular chat product.

## What will you build?

| Build | Add with Mobius |
| --- | --- |
| An Agent interface in your product | Connect your own UI to sessions, live replies, settings, and results |
| A remote control client | Let users check work and give the next instruction from another device |
| A shared workspace for Agent work | Let multiple clients watch a session and see interaction from elsewhere |

## One foundation, from your app to the Agent

```text
Your application  →  Mobius SDK  →  Relay  →  Local daemon  →  Coding Agent
```

The SDK gives your application the integration surface. The Relay routes authorized
requests and live output. The daemon connects to Agents on the user's machine.
Together, they let you build remote Agent experiences while local actions remain
authorized at the machine where they execute.

Agent capabilities vary by Runtime and configuration. Discover the available operations
rather than assuming every Agent supports the same features.

## Built with Mobius

[**Morty**](https://github.com/moxt-ai/morty) uses Mobius to provide browser chat with
coding Agents, live replies, and conversation history. Its Bot model and chat
interface belong to Morty; Mobius supplies the underlying Agent connectivity.

Use Morty as an example of what you can build, or bring Mobius into your own application.

## Start with the SDK

```sh
npm install @moxt-ai/mobius-sdk
```

- **[Read the integration guide](GUIDE.md#start-with-the-sdk)** for prerequisites,
  credentials, and a backend example.
- **[Explore the SDK](packages/mobius-sdk/README.md)** for server, Platform, and live-channel integration.
- **[Try the development walkthrough](packages/mini-client/README.md)** to exercise
  Runtime pairing and sessions without Morty.

## Data ownership and recovery

Agents keep their native environment and saved history. Optional cloud Recording
makes received history accessible without the connected machine. Live delivery and
Recording are best effort; daemon restarts lose running work and queued prompts.
See the [delivery, storage, and recovery guide](GUIDE.md#live-output-and-recovery)
for the boundaries your application should account for.

## Contributing

Help improve the SDK and infrastructure. See [CONTRIBUTING.md](CONTRIBUTING.md) for
local development, verification, and submission guidance.

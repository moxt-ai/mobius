<div align="center">

# Mobius

[English](README.md) · **简体中文**

### 基于用户已有的编程 Agent，构建你的产品。

为应用接入用户机器上的 Agent，提供 SDK 与远程连接基础设施。

[开始构建](packages/mobius-sdk/README.md#start-building) · [参与贡献](docs/CONTRIBUTING.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@moxt-ai/mobius-sdk.svg?label=%40moxt-ai%2Fmobius-sdk)](https://www.npmjs.com/package/@moxt-ai/mobius-sdk)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19.0-111.svg)](https://nodejs.org)

<img src="docs/assets/readme-accent.svg" width="320" height="40" alt="" />

</div>

将编程 Agent 会话接入你的应用，提供实时输出、远程指令和多端共享视图。
Mobius 负责连接 Agent，用户继续使用自己的项目、工具和原生开发环境。

## 为什么选择 Mobius

- **一次集成，连接多种 Agent。** 通过统一的 TypeScript SDK 接入，无需为每种 Agent
  分别实现远程连接和会话交互。
- **在用户的机器上工作。** 连接代码、工具和 Agent 历史记录所在的环境。
- **让进行中的工作可见、可参与。** 向多个客户端实时推送回复，发送后续指令、停止执行，
  并响应 Agent 支持的权限审批请求。

## 自行部署，或开箱即用。

把 Mobius 部署到**自己的 Cloudflare 账号，免费套餐也支持**；
或直接使用我们提供的**免费托管服务**。两种方式都能利用 Cloudflare 的全球网络。
应用可以根据用户所在地自动选择项目区域，Mobius 按这个选择路由项目请求，
让共享工作更靠近主要受众。Cloudflare 提供就近边缘入口，并依据区域偏好安排计算节点。

支持的区域包括北美、欧洲、亚太（含东北亚、东南亚）和大洋洲等。
当前托管存储配置在**亚太和北美西部**。

## 历史记录，由你选择。

将 Agent 历史记录保留在连接的机器上，或按需开启云端 Recording，
在机器离线时查看已录制的历史。根据应用对隐私和可用性的需求，自由选择。

Recording **默认关闭**。它按项目、再按应用、最后回落到系统默认值 `disabled` 逐级解析，
并且还需要已部署的 provider 才会生效——仅有 provider 绑定并不会打开它。
一旦启用，存储的会话信封可能包含提示词、助手回复，以及工具的输入与输出
（含工具产出的文件内容）。请慎重决定，并明确告知你的用户。

[了解历史记录与存储选项 →](packages/mobius-sdk/README.md#history-and-reconnects)

## 从你的应用，连接到用户的机器

```text
你的应用  →  Mobius SDK  →  Relay  →  本地 daemon  →  编程 Agent
```

应用界面和访问策略由你决定。Agent 在连接的机器上执行，本地操作在执行机器上获得授权。
具体可用能力取决于 Agent 及其配置。

## 安全模型

这部分值得说清楚，因为它决定了 Mobius 能承诺什么、不能承诺什么：

- **执行发生在本地。** Agent 在用户自己的机器上、以用户自己的操作系统账号运行。
  Mobius 负责转发指令和输出，不代替用户执行代码。
- **Relay 是被信任的，而不是无法读取的。** 会话流量以 relay 可处理的形式经过 relay。
  **Mobius 不是端到端加密的。** 如果你的产品需要 E2EE，Mobius 目前无法提供；
  若你希望那个被信任的组件是你自己，请把 relay 部署到你自己的 Cloudflare 账号。
- **身份按机器隔离。** 已连接机器的身份保存在该用户的本地应用数据目录中，
  由文件系统权限保护，不会在机器之间同步。
- **访问可授予，也可撤销。** 分享会把"查看并操作该项目会话"的能力交给对方。
  撤销是一等操作，作用范围是该机器本地配置中保存的那个项目。

报告安全漏洞请见 [SECURITY.md](SECURITY.md)。请不要为安全问题创建公开 issue。

## 运行条件

- 使用 `@moxt-ai/mobius-sdk` 需 **Node.js 20.19.0 或更高版本**；`@moxt-ai/mobius` CLI 需 **22.19.0 或更高版本**
- 若自行部署，需要一个 Cloudflare 账号（免费套餐即可起步）
- 参与本仓库开发请使用 `.nvmrc` 中固定的版本

## 基于 Mobius 构建

[**Morty**](https://github.com/moxt-ai/morty) — 基于 Mobius 构建的浏览器客户端，
提供远程编程 Agent 对话、实时回复和历史记录。

---

## 开始构建

```sh
npm install @moxt-ai/mobius-sdk
```

**[阅读 SDK README →](packages/mobius-sdk/README.md#start-building)**

配置连接，发起第一次 SDK 请求，再运行完整的会话示例。

想改进 Mobius？请阅读[贡献指南](docs/CONTRIBUTING.md)。

## 许可

[Apache License 2.0](LICENSE)，另见 [NOTICE](NOTICE)。

在采用该许可之前发布的包，其元数据中标注为 `ISC`；这些已发布的版本仍按当时标注的许可提供。

"Mobius"、"Moxt" 及其标识是 Moxt 的商标。Apache 2.0 授予你的是代码的权利，
不包括名称和标识——欢迎 fork，但请给它取一个自己的名字。

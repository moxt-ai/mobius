<div align="center">

# Mobius

[English](README.md) · **简体中文**

### 基于用户已有的编程 Agent，构建你的产品。

为应用接入用户机器上的 Agent，提供 SDK 与远程连接基础设施。

[开始构建](docs/GUIDE.md#start-with-the-sdk) · [SDK 参考](packages/mobius-sdk/README.md) · [参与贡献](docs/CONTRIBUTING.md)

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

## 历史记录，由你选择。

将 Agent 历史记录保留在连接的机器上，或按需开启云端 Recording，
在机器离线时查看已录制的历史。根据应用对隐私和可用性的需求，自由选择。

[了解历史记录与存储选项 →](docs/GUIDE.md#data-ownership-and-recovery)

## 从你的应用，连接到用户的机器

```text
你的应用  →  Mobius SDK  →  Relay  →  本地 daemon  →  编程 Agent
```

应用界面和访问策略由你决定。Agent 在连接的机器上执行，本地操作在执行机器上获得授权。
具体可用能力取决于 Agent 及其配置。

## 基于 Mobius 构建

[**Morty**](https://github.com/moxt-ai/morty) — 基于 Mobius 构建的浏览器客户端，
提供远程编程 Agent 对话、实时回复和历史记录。

---

## 开始构建

```sh
npm install @moxt-ai/mobius-sdk
```

**[阅读接入指南 →](docs/GUIDE.md#start-with-the-sdk)**

配置连接并发起第一次 SDK 请求。浏览器和服务端集成方式见 [SDK 参考](packages/mobius-sdk/README.md)。

想改进 Mobius？请阅读[贡献指南](docs/CONTRIBUTING.md)。

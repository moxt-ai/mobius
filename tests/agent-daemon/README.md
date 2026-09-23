# Controlled Agent tests

These integration tests run the production Mobius daemon and a controlled ACP Agent through the local protocol. Run them with `pnpm test:agent-daemon:controlled`.

`pnpm test:agent-daemon:real` runs the production daemon with a real Codex binary and an isolated local model provider. It requires Codex CLI 0.154.0 on `PATH` (or `MOBIUS_TEST_CODEX_PATH`). The model provider is controlled so no account, remote model call, or existing Codex session is used.

# Mobius mini-client

This private developer tool drives the Mobius Platform and a local Mobius CLI without Mobius Chat. It creates one isolated Platform Project, pairs the checkout's CLI as a Runtime, and persists only the identifiers needed by later commands.

The state directory contains an AppCredential and Runtime credentials. `create` generates a fresh temporary directory by default so concurrent checkouts use independent Mobius CLI managers. Do not commit it, and remove it after verification.

## Prerequisites

1. Install this repository with its pinned Node and pnpm versions:

   ```sh
   pnpm install
   ```

2. Start a local Platform Worker in another terminal:

   ```sh
   pnpm dev
   ```

3. Obtain an App ID and AppCredential provisioned in that local Platform. The default Worker origin is `http://127.0.0.1:8787`.
4. Confirm that at least one supported local Agent is installed:

   ```sh
   pnpm mobius agents
   ```

Run the following commands from `packages/mini-client`.

## Create and pair an isolated Runtime

Keep secrets out of shell history where possible:

```sh
read -r MOBIUS_TEST_APP_ID
read -rs MOBIUS_TEST_APP_SECRET
printf '\n'
export MOBIUS_TEST_APP_ID MOBIUS_TEST_APP_SECRET

MOBIUS_MINI_CREATE="$(pnpm exec tsx ./index.ts \
  create \
  --app-id="$MOBIUS_TEST_APP_ID" \
  --app-secret="$MOBIUS_TEST_APP_SECRET")"
printf '%s\n' "$MOBIUS_MINI_CREATE"
export MOBIUS_MINI_STATE="$(printf '%s' "$MOBIUS_MINI_CREATE" | node -e \
  'let value=""; process.stdin.on("data", chunk => value += chunk).on("end", () => process.stdout.write(JSON.parse(value).stateDir))')"
```

`create` creates a Platform Project and Runtime pairing, launches `pnpm mobius pair` with its own `MOBIUS_STATE_DIRECTORY`, and waits for the detached local Runtime to report online. It prints the generated `stateDir` and identifiers but never the credential. Pass `--state-dir` only when an owner-provided location is required.

Inspect the Runtime and available Agents:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" status
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" list-runtimes
```

## Create and configure a Session

When the Runtime advertises more than one Agent, pass the selected Agent ID:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  create-session \
  --agent=codex \
  --title="Mini-client verification"
```

Save the returned `sessionId`, then inspect and update a setting offered in `configOptions`:

```sh
export MOBIUS_TEST_SESSION='<sessionId>'

pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  get-agent-configuration \
  --session="$MOBIUS_TEST_SESSION"

pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  update-agent-configuration \
  --session="$MOBIUS_TEST_SESSION" \
  --config-id='<offered-config-id>' \
  --value='<offered-value>'
```

Boolean settings accept only `true` or `false`. Select settings accept only values advertised by the Agent.

## Prompt, steer, and reconcile messages

Start following the Session in one terminal. The command first reconciles from `queryNativeMessages`, then refreshes the authoritative snapshot for each live event. It reconnects and reconciles again if the stream is interrupted.

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  get \
  --session="$MOBIUS_TEST_SESSION" \
  --follow
```

In another terminal, start a Turn:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  send-prompt \
  --session="$MOBIUS_TEST_SESSION" \
  --prompt='Write a short checklist and keep working until it is complete.'
```

While that Turn is running, steer it:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  steer \
  --session="$MOBIUS_TEST_SESSION" \
  --prompt='Make the final checklist exactly three items.'
```

To exercise queueing instead, submit with `--disposition=queue`. The mini-client resolves the target from its most recent locally submitted running Turn.

After completion, read a finite reconciled snapshot and confirm that the original prompt, steering prompt, and Agent result appear once:

```sh
pnpm exec tsx ./index.ts \
  --state-dir="$MOBIUS_MINI_STATE" \
  get \
  --session="$MOBIUS_TEST_SESSION"
```

Other useful operations are:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" list-sessions
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" cancel-turn --session="$MOBIUS_TEST_SESSION" --turn='<turnId>'
```

## Stop, resume, and clean up

`stop` addresses the detached Runtime by its opaque Connection ID; it does not signal a recorded PID:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" stop
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" status
```

Resume the same saved Runtime when needed:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" start
```

At the end, stop it and remove the isolated state:

```sh
pnpm exec tsx ./index.ts --state-dir="$MOBIUS_MINI_STATE" stop
rm -rf -- "$MOBIUS_MINI_STATE"
```

Only remove a state directory created specifically for this workflow.

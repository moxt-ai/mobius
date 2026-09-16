# Native session discovery and browser access

Application backends discover native local-agent sessions through the Project SDK.
After selection/import, they issue a short-lived credential for the resolved Session.
The browser then communicates directly with Mobius through the Session SDK.

```text
Browser -> App backend -> Mobius -> Runtime: native session listing/import
Browser <- App backend: selected Session credential
Browser <-> Mobius <-> Runtime: history, turns, configuration, events, cancellation
```

## Backend operations

- `client.runtimes.nativeSessions(runtimeId, request, signal)` accepts `list` or
  `import`. Requests include `agentId`, `directoryId`, `additionalDirectoryIds`,
  and either `cursor` or `entryId`. Pass `discoveryId: null` for an initial listing,
  then pass the returned `sessionId` as `discoveryId` for pagination and import so
  the Runtime can resolve entries from that discovery context. Runtime and Project authorization are enforced
   before connecting to the local agent. Imports resolve to a ready Session,
   reusing its canonical identity when already imported. Failed imports propagate
   the opening error without falling back to a read-only preview. A separate
   `preview` action reads saved history without opening a Session; for Codex it
   reads through `thread/read`/`thread/turns/list` instead of ACP `session/load`,
   so it never contends with Codex's exclusive writer lock.
- `client.runtimes.findNativeSessionByNativeSessionId(runtimeId, request, signal)`
  performs a bounded, paginated lookup at the local Runtime boundary. It validates
  the resolved workspace and returns a fresh opaque entry plus discovery context for
  the existing import operation. Ordinary listings and lookup results never disclose
  the native session ID.
- `client.sessions.createAccess(sessionId, expiresInSeconds, signal)` issues an
  `msession_…` credential for an existing Session in the App's Project. Supported
  lifetimes are 60–3600 seconds. Parent App keys do not expire; their revocation
  and rotation overlap are still enforced.
- Discovery uses a server-owned control connection, which is closed and its
  internal credential removed on completion, failure, or cancellation. No Runtime
  host token is returned to the application or browser.

## Browser operations

Use `MobiusClient` with the returned endpoint, Project ID, and a credential provider
that obtains replacements from the application backend before expiration.

The credential authorizes only the selected Session's read, messages, native
history, events, turn submission/read/cancellation, preparation and configuration
routes. It cannot enumerate Sessions or Runtimes, access another Session, issue
credentials, delete Sessions, or change Session bindings. Both the requested route
and the resolved Project are checked. Preparation/configuration resolve the stored
Session binding; callers cannot supply another Runtime or binding.

Parent credential expiry, revocation, revision, Project grants and required
permissions are checked on each request. Event streams are bounded by credential
expiry; reconnecting reauthorizes access. Runtime-local execution authorization
continues to govern agent actions.

Apply Platform `migrations/sharding/0001_platform_project_credentials.sql` before
deployment. Existing Bot conversations continue to use their conversation-scoped
credentials and browser SDK.

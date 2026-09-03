# Development Guide

## Local Execution Boundary

Mobius connects remote clients to agent harnesses running on a user's machine. The process that performs a local side effect is therefore the final and only trusted enforcement point.

Every operation that can affect the local machine must follow the same pipeline:

```text
untrusted input
  -> schema validation
  -> normalization and target resolution
  -> capability and target authorization
  -> execution
  -> audit event
```

Keep validation and authorization distinct. Schema validation establishes that a request is well formed; authorization establishes that the active session may perform that specific operation. Neither result implies the other.

For values whose meaning can change after resolution, check both forms. Examples include symbolic links, relative paths, redirects, hostnames, executable lookup, and command arguments. Authorization must be repeated at the local execution boundary immediately before the side effect.

## Make Illegal States Unrepresentable

Use a discriminated union when behavior or available data depends on a lifecycle or protocol state:

```ts
type SessionState =
  | { readonly kind: "connecting" }
  | {
      readonly kind: "active";
      readonly sessionId: string;
      readonly capabilities: ReadonlySet<Capability>;
    }
  | { readonly kind: "closed"; readonly reason: CloseReason };
```

Do not model the same concept as unrelated optional fields:

```ts
// Invalid combinations are possible: active without a session ID, or closed with capabilities.
interface SessionState {
  readonly active?: boolean;
  readonly sessionId?: string;
  readonly capabilities?: ReadonlySet<Capability>;
  readonly closeReason?: CloseReason;
}
```

State transitions should accept only valid source states and return a complete destination state. Consumers must use exhaustive branching without a permissive `default` branch. Use an `assertNever` helper when the control flow does not otherwise prove exhaustiveness.

Use optional properties only when absence is meaningful within the same state. Use `null` only when an explicit empty value is part of the domain. Reserve `Partial<T>` for update payloads, never for lifecycle or protocol states.

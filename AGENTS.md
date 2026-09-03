# Engineering Rules

These rules apply to the entire repository. See [DEVELOPMENT.md](./DEVELOPMENT.md) for rationale and examples.

## Trust Boundary

The local execution boundary is the only authority allowed to approve local side effects.

- Treat every value received from a remote client, transport, agent harness, model, configuration file, or persisted session as untrusted input.
- Process untrusted input in this order: decode as `unknown`, validate its schema, normalize and resolve security-sensitive targets, authorize the requested capability and resolved target, execute, then record an audit event.
- Validate both the requested representation and the resolved representation of paths, URLs, commands, and other security-sensitive targets.
- Never let a remote assertion, prior validation result, or user-interface approval bypass authorization at the execution boundary.

## State Modeling

Make illegal states unrepresentable.

- Represent protocol and lifecycle states with discriminated unions, not combinations of optional fields or booleans.
- Give each variant exactly the data that is valid in that state, using `readonly` properties for state values.
- Handle state variants exhaustively so a new variant causes a compile-time failure at every incomplete decision point.
- Express state changes through explicit transition functions. Do not mutate fields into a different state.
- Do not use type assertions, `Partial`, or non-null assertions to bypass state invariants.

## Verification

Run `pnpm check` before submitting a pull request.

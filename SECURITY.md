# Security Policy

Mobius connects an application to a coding Agent running on a user's own machine.
It carries session traffic across a trust boundary, so pairing, authorization, and
the relay are the parts most worth scrutiny. We would rather hear about a problem
from you than from an incident.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub private vulnerability reporting:
[**Report a vulnerability**](https://github.com/moxt-ai/mobius/security/advisories/new).
The report stays private between you and the maintainers until a fix ships.

Helpful things to include:

- what an attacker can do, and what they need in order to do it
- the smallest reproduction you have, and which package it involves
  (`@moxt-ai/mobius-sdk`, the `@moxt-ai/mobius` CLI, relay, platform, or daemon)
- affected versions or commit
- whether the path requires the hosted service or reproduces on a self-deployed relay

Please do not include live credentials, pairing tickets, or customer data in a
report. Describe where they appear instead.

## What to expect

- We acknowledge a report within **3 business days**.
- We send an initial assessment, including whether we consider it in scope, within
  **10 business days**.
- We keep you updated while a fix is in progress, and we credit you in the advisory
  unless you ask us not to.

## Scope

In scope:

- this repository and the packages it publishes
- pairing, project and session authorization, sharing, and revocation
- the relay and platform, whether hosted by us or self-deployed
- the local daemon and its handling of locally stored identity

Report issues specific to the Morty browser client to
[Morty](https://github.com/moxt-ai/morty/security/advisories/new) instead.

Generally out of scope:

- findings that require an already-compromised connected machine, or an attacker
  who already has the operating-system account that ran setup
- missing hardening with no demonstrated impact, and automated scanner output
  without a working path to exploitation
- denial of service through traffic volume
- the relay being able to observe session traffic it routes. Mobius is not
  end-to-end encrypted; the relay is a trusted component by design. See
  [Security model](README.md#security-model).

## Testing against your own deployment

Test against projects, machines, and deployments you control. Do not attempt to
reach other users' sessions, and do not run tests that degrade the hosted service
for other people. If a test accidentally gives you access to something that is not
yours, stop, and tell us what happened in the report.

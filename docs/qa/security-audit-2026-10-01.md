# Security review — 1 October 2026

This review starts from `bea776d` (PR 66). It combines source review, adversarial regression tests, a route authentication inventory, dependency scanning and isolated PostgreSQL tests. It is not a penetration-test certification or a claim that the system has no bugs.

## Fixed findings

- **Support-session replay:** the support exit endpoint accepted a signed but expired/ended support cookie and minted a fresh membership cookie with the current account version. It now checks the current grant, origin, account status and version; consumes the grant once; and preserves the authenticated version. Concurrent exits issue only one cookie.
- **Revoked support access:** password/session revocation and a disabled customer business now invalidate support reads. Logging out also ends the support grant on the server.
- **Invitation races:** simultaneous requests could update an unclaimed account's password twice before only one request consumed the invitation. Account locking and one transaction now cover password claim, invitation consumption and audit. Separate invitations for the same account cannot replace a password already claimed by another request.
- **Password-change races:** changing a password requires the account to retain the authenticated version and the verified password hash at update time. A competing change is refused instead of overwriting the winning password.
- **Revoked logout cookies:** invalidated cookies are cleared without taking an active user's dialer offline.
- **Authentication throttling:** login, invitations, password changes and signup now use atomic database counters shared across server instances. Parallel public support submissions use the same limiter. The old process-local maps were insufficient for serverless deployments.
- **Signup origin/validation:** cross-origin signup is refused before account creation; malformed signup input returns 400 instead of 500.
- **Meta paging destinations:** the advertising API refuses an off-domain URL before sending the business access token, including URLs returned in pagination responses. Redirect following remains disabled.
- **Test reliability:** telephony fixture phone numbers no longer depend on two adjacent millisecond timestamps that can collide.

## Rate-limit behavior and deployment

`20261015090000_auth_rate_limits` is an additive migration. Apply it before deploying the code. No existing tables or customer records are removed. Rollback can retain the new table safely.

Counters include successful and failed attempts, and reset on window expiry: login 10 per email / 15 minutes and 60 per forwarded IP / 15 minutes; invite acceptance 5 per account / 15 minutes; password change 5 per account / 15 minutes; signup and public support 5 per IP / hour. Email limits still apply without a forwarded IP. As before, IP handling assumes the hosting proxy supplies a trusted `x-forwarded-for` header; a self-hosted installation must enforce this at its proxy. Limits return 429 and fail closed if the database is unavailable.

The limiter stores hashed identifiers, counts and expiry times, without plaintext passwords, invitation tokens or emails. The existing retention job removes expired keys in bounded batches of 10,000.

## Evidence

- Six initial exploit/regression cases failed on the previous code and passed after correction.
- API boundary tests enumerate all 347 routes using the session-authentication entry points and exercise every exported HTTP method. Anonymous calls are rejected; mutations reject cross-origin requests. The two Meta OAuth navigation endpoints redirect only to the local error page with `reason=unauthorized`.
- Separate tests cover single and cross-invitation races, revoked/expired grants, simultaneous support exits and password changes, shared limiter bursts, expiry, signup origins, and Meta token destination restrictions.
- A targeted scan of 1,046 tracked source, migration and script files found no matching embedded private-key, GitHub-token, AWS-access-key or live-Stripe-key patterns. This is a limited pattern scan, not proof that no secret has ever entered Git history.
- `npm audit --omit=dev` reported zero known vulnerabilities at review time.
- Full test/build results are recorded in the PR description after completion.

## Remaining security work and limits

- Application login has no MFA/SSO enforcement. Platform administration and government deployments need an agreed identity/access policy and implementation.
- Self-service signup still lacks email-ownership verification. The platform email provider is not configured; signup must not be represented as a verified identity flow.
- The production backup/PITR retention policy and a restore from production backups have not been verified by this review.
- Live WhatsApp, telephony and payment providers, external penetration testing, production load, every browser/device combination and all historical repository secrets are outside the verified scope.
- The CSP is a compatibility baseline (`frame-ancestors`, `object-src`, `base-uri`), not a complete script nonce policy. A stricter script policy needs a separate Meta/WebRTC-compatible rollout.
- Rate limiting mitigates guessing, but does not replace MFA, upstream abuse protection or monitoring.

These gaps prevent a claim of “government-grade certification” or “zero bugs,” even when every automated check passes.

# Sales development increment: follow-up execution and first-dial targets

Implemented on this branch, not a claim of production deployment:

1. Manager-written scheduled follow-up check-in rules, verified agent replies, real connection grace, and guarded transfers.
2. Explicit unsupported-capability responses in the internal AI and rule builder.
3. Initial response SLA: configurable clock-time target, actual first-dial attribution, overdue alerts, and recorded elapsed time. Automatic SLA redistribution, business-hour calendars, and aggregate SLA reporting remain outstanding.

See `AI_OPS_MANAGER.md` for activation, precise behavior and limitations. Both new rule kinds are opt-in and reuse the existing cron, WhatsApp transport and operations tables. No migration is required.

Next accepted work: versioned customer quotes and verified payment results, approved commercial offers and shared closing pages, live expert joining, presales qualification, answer-rate diagnostics, originating Meta ad context, and buyer decision-maker participation. Referral acquisition is excluded. Payment-provider selection is still outstanding; no payment integration is implemented here.

Quote/payment acceptance criteria: server-calculated amounts and currency, immutable shared versions, expiry/revocation, customer confirmation bound to one version, provider-confirmed payments rather than success-page redirects, idempotent verified webhooks, separate refund ledger, and no internal CRM notes exposed on customer pages.

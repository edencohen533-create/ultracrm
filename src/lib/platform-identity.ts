/**
 * Who operates the platform – shown on the public pages Meta reviews (privacy policy, terms, data deletion, support).
 * Set in the deployment environment; the pages say plainly when a value is not configured yet.
 */
export function platformIdentity() {
  return {
    product: process.env.PLATFORM_PRODUCT_NAME || "Solina CRM",
    legalName: process.env.PLATFORM_LEGAL_NAME || null,
    address: process.env.PLATFORM_ADDRESS || null,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    privacyEmail: process.env.PRIVACY_EMAIL || process.env.SUPPORT_EMAIL || null,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://ultracrm-eta.vercel.app",
    updated: "2026-09-28",
  };
}

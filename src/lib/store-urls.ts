/** Public URLs for a store connection (shown in the setup screen). */
export const appBase = () => (process.env.NEXT_PUBLIC_APP_URL ?? "https://ultracrm-eta.vercel.app").replace(/\/$/, "");
export const scriptUrl = (publicKey: string) => `${appBase()}/api/track/${publicKey}/script`;
export const snippetFor = (publicKey: string) => `<script async src="${scriptUrl(publicKey)}"></script>`;
export const webhookUrlFor = (platform: string, storeId: string) => `${appBase()}/api/webhooks/stores/${platform}/${storeId}`;

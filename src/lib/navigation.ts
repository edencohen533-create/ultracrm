/** Login redirects may only point to a path within this application. */
export function safeReturnPath(value: string | null): string {
  if (!value?.startsWith("/")) return "/";
  const origin = "https://ultracrm.invalid";
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

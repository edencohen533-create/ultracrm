/** Render supported call-script fields as plain text; unknown placeholders remain visible for correction. */
export function renderCallScript(body: string, fields: { agent?: string; business?: string; name?: string; phone?: string }) {
  return body.replace(/\{\{\s*(agent|business|name|phone)\s*\}\}/g, (placeholder, key: keyof typeof fields) => fields[key] ?? placeholder);
}

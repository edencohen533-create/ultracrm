/**
 * Named merge tags for SMS / email with per-tag defaults:
 *   {{name}}            → contact full name
 *   {{first_name|לקוח}} → first word of the name, "לקוח" when missing
 *   {{company|}}, {{city|}}, {{email|}}, {{phone|}}
 *   {{custom.<key>|default}} → contact custom field
 *   {{unsubscribe_url}} → per-recipient signed unsubscribe link (inserted by the sender)
 * A tag without a default that has no value is reported as missing (the UI asks for a default).
 * WhatsApp keeps its numbered {{1}} style (Meta-approved templates) – see src/lib/campaigns.ts.
 */
const TAG_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|([^}]*))?\}\}/g;

export interface MergeContact {
  fullName: string;
  email?: string | null;
  phoneE164?: string | null;
  company?: string | null;
  city?: string | null;
  customFields?: Record<string, unknown> | null;
}

export const KNOWN_TAGS = ["name", "first_name", "company", "city", "email", "phone", "unsubscribe_url", "cart_url", "cart_total", "cart_items"] as const;

export function mergeTagsOf(text: string): Array<{ tag: string; fallback: string | null }> {
  const out = new Map<string, string | null>();
  for (const m of text.matchAll(TAG_RE)) if (!out.has(m[1])) out.set(m[1], m[2] === undefined ? null : m[2]);
  return [...out].map(([tag, fallback]) => ({ tag, fallback }));
}

export function isKnownTag(tag: string) {
  return (KNOWN_TAGS as readonly string[]).includes(tag) || tag.startsWith("custom.");
}

function valueOf(tag: string, c: MergeContact, extra: Record<string, string>): string | null {
  if (extra[tag] !== undefined) return extra[tag];
  switch (tag) {
    case "name": return c.fullName?.trim() || null;
    case "first_name": return c.fullName?.trim().split(/\s+/)[0] || null;
    case "company": return c.company?.trim() || null;
    case "city": return c.city?.trim() || null;
    case "email": return c.email?.trim() || null;
    case "phone": return c.phoneE164 || null;
    default: {
      if (tag.startsWith("custom.")) {
        const v = c.customFields?.[tag.slice(7)];
        return v === undefined || v === null || v === "" ? null : String(v);
      }
      return null;
    }
  }
}

export interface MergeResult {
  text: string;
  /** Tags that had neither a value nor a default. */
  missing: string[];
  /** Tags whose default was used. */
  defaulted: string[];
}

export function renderMergeTags(text: string, contact: MergeContact, extra: Record<string, string> = {}): MergeResult {
  const missing = new Set<string>();
  const defaulted = new Set<string>();
  const out = text.replace(TAG_RE, (_m, tag: string, fallback?: string) => {
    const v = valueOf(tag, contact, extra);
    if (v !== null) return v;
    if (fallback !== undefined) { defaulted.add(tag); return fallback; }
    missing.add(tag);
    return "";
  });
  return { text: out, missing: [...missing], defaulted: [...defaulted] };
}

/** Validation for templates: unknown tags are rejected; tags that can be empty need a default. */
export function validateMergeTags(text: string): string[] {
  const problems: string[] = [];
  for (const { tag, fallback } of mergeTagsOf(text)) {
    if (!isKnownTag(tag)) problems.push(`משתנה לא מוכר: {{${tag}}}`);
    else if (["company", "city", "email"].includes(tag) || tag.startsWith("custom.")) { if (fallback === null) problems.push(`למשתנה {{${tag}}} נדרש ערך ברירת מחדל, למשל {{${tag}|-}}`); }
  }
  if (/\{\{[^}]*$/.test(text) || /\{[^{]|[^}]\}/.test(text.replace(TAG_RE, ""))) problems.push("סוגריים מסולסלים לא סגורים");
  return problems;
}

/** Escape user text for HTML rendering. */
export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

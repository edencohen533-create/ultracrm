import Link from "next/link";
import { serverT } from "@/lib/i18n-server";
import { platformIdentity } from "@/lib/platform-identity";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";

/** Header + footer of the public (logged-out) pages. */
export async function PublicShell({ children }: { children: React.ReactNode }) {
  const t = await serverT();
  const id = platformIdentity();
  const nav: Array<[string, string]> = [["/privacy", t("מדיניות פרטיות", "Privacy Policy")], ["/terms", t("תנאי שימוש", "Terms of Service")], ["/data-deletion", t("מחיקת נתונים", "Data Deletion")], ["/support", t("תמיכה", "Support")]];
  return (
    <div className="min-h-screen bg-bg text-text flex flex-col" data-testid="public-shell">
      <header className="border-b border-line bg-panel">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link href="/" className="font-bold text-lg flex items-center gap-2"><span className="inline-flex w-7 h-7 rounded-md bg-accent text-white items-center justify-center text-sm">U</span>{id.product}</Link>
          <nav className="hidden md:flex gap-4 text-sm text-muted">{nav.map(([h, l]) => <Link key={h} href={h} className="hover:text-text">{l}</Link>)}</nav>
          <div className="ms-auto flex items-center gap-4"><LanguageToggle /><Link href="/login" className="rounded-md bg-accent text-white px-3 h-9 inline-flex items-center text-sm font-medium" data-testid="public-login">{t("כניסה", "Log in")}</Link></div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line bg-panel text-xs text-muted">
        <div className="max-w-5xl mx-auto px-4 py-6 flex flex-wrap gap-x-6 gap-y-2 items-center">
          <span>© {new Date().getFullYear()} {id.legalName ?? id.product}</span>
          {nav.map(([h, l]) => <Link key={h} href={h} className="hover:text-text">{l}</Link>)}
          {id.supportEmail && <a href={`mailto:${id.supportEmail}`} className="hover:text-text">{id.supportEmail}</a>}
          <span className="ms-auto">{t("WhatsApp הוא סימן מסחרי של WhatsApp LLC. השירות משתמש ב-WhatsApp Business Platform של Meta.", "WhatsApp is a trademark of WhatsApp LLC. This service uses Meta's WhatsApp Business Platform.")}</span>
        </div>
      </footer>
    </div>
  );
}

/** Readable legal/document page body. */
export function Doc({ title, updated, children }: { title: string; updated?: string; children: React.ReactNode }) {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 space-y-4 leading-relaxed [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-2 [&_ul]:list-disc [&_ul]:ps-6 [&_ul]:space-y-1 [&_p]:text-[15px] [&_li]:text-[15px] [&_a]:underline">
      <h1 className="text-2xl font-bold">{title}</h1>
      {updated && <p className="text-xs text-muted">{updated}</p>}
      {children}
    </article>
  );
}

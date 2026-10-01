"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { safeReturnPath } from "@/lib/navigation";
import { Button, Input } from "@/components/ui";
import Link from "next/link";
import { useT } from "@/components/i18n/LangProvider";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";

function LoginForm() {
  const t = useT();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post<{ role: string }>("/api/auth/login", { email, password });
      // A new identity must start with fresh module caches, permissions and provider state.
      window.location.assign(safeReturnPath(params.get("next")));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm bg-panel border border-line rounded-2xl p-7 space-y-4">
      <div className="text-center mb-2">
        <div className="w-12 h-12 rounded-xl bg-accent text-white font-bold text-xl flex items-center justify-center mx-auto mb-3">U</div>
        <h1 className="text-lg font-semibold">{t("כניסה ל-UltraCRM", "Log in to UltraCRM")}</h1><p className="text-xs text-muted mt-1">{t("CRM · דיוור · טלפוניה · WhatsApp", "CRM · Messaging · Telephony · WhatsApp")}</p>
      </div>
      <Input label={t("אימייל", "Email")} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required ltr />
      <Input label={t("סיסמה", "Password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required ltr />
      <Button type="submit" className="w-full" loading={loading} size="lg">
        {t("כניסה", "Log in")}
      </Button>
      <div className="flex justify-between items-center text-xs text-muted pt-1"><LanguageToggle /><span className="flex gap-3"><Link href="/privacy" className="hover:underline">{t("פרטיות", "Privacy")}</Link><Link href="/terms" className="hover:underline">{t("תנאים", "Terms")}</Link><Link href="/support" className="hover:underline">{t("תמיכה", "Support")}</Link></span></div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}

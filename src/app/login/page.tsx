"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button, Input } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const u = await api.post<{ role: string }>("/api/auth/login", { email, password });
      const next = params.get("next");
      router.push(next && next.startsWith("/") ? next : u.role === "agent" ? "/dialer" : "/manager");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm bg-panel border border-line rounded-2xl p-7 space-y-4">
      <div className="text-center mb-2">
        <div className="w-12 h-12 rounded-xl bg-accent text-white font-bold text-xl flex items-center justify-center mx-auto mb-3">D</div>
        <h1 className="text-lg font-semibold">כניסה למוקד</h1>
      </div>
      <Input label="אימייל" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required ltr />
      <Input label="סיסמה" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required ltr />
      <Button type="submit" className="w-full" loading={loading} size="lg">
        כניסה
      </Button>
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

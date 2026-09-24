"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";

export interface Me {
  user: { id: string; fullName: string; email: string; role: "owner" | "manager" | "agent"; teamId: string | null; presence: string };
  business: { id: string; name: string; slug: string; timezone: string };
  businesses: Array<{ id: string; name: string; role: string; active: boolean }>;
  modules: { crm: boolean; messaging: boolean; telephony: boolean };
  plan: { key: string | null; name: string | null };
  telephony: { provider: string; simulation: boolean };
}

let cached: Me | null = null;

/** Current user + business + enabled modules (cached per page load). */
export function useMe() {
  const [me, setMe] = useState<Me | null>(cached);
  useEffect(() => {
    if (cached) return;
    api.get<Me>("/api/auth/me").then((m) => { cached = m; setMe(m); }).catch(() => undefined);
  }, []);
  return me;
}

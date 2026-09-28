import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import { getLang } from "@/lib/i18n-server";
import { dirOf } from "@/lib/i18n";
import { LangProvider } from "@/components/i18n/LangProvider";

const heebo = Heebo({ subsets: ["hebrew", "latin"], variable: "--font-heebo", weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "UltraCRM",
  description: "CRM, WhatsApp Business messaging, dialer, SMS and email in one platform",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0e14" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  const dir = dirOf(lang);
  return (
    <html lang={lang} dir={dir} className={`${heebo.variable} dark`}>
      <body>
        <LangProvider lang={lang}><TooltipProvider>{children}</TooltipProvider></LangProvider>
        <Toaster position={dir === "rtl" ? "bottom-left" : "bottom-right"} richColors closeButton dir={dir} theme="dark" toastOptions={{ style: { fontFamily: "var(--font-heebo)" } }} />
      </body>
    </html>
  );
}

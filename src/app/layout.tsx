import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const heebo = Heebo({ subsets: ["hebrew", "latin"], variable: "--font-heebo", weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "UltraCRM",
  description: "CRM, דיוור וטלפוניה במערכת אחת",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0e14" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} dark`}>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-left" richColors closeButton dir="rtl" theme="dark" toastOptions={{ style: { fontFamily: "var(--font-heebo)" } }} />
      </body>
    </html>
  );
}

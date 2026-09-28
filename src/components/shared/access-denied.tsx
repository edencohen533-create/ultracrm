import { serverT } from "@/lib/i18n-server";

export async function AccessDenied() {
  const t = await serverT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-lg font-semibold">{t("אין לך הרשאה לצפות בעמוד זה", "You don't have permission to view this page")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("פנה למנהל המערכת אם אתה סבור שזו טעות.", "Contact your system administrator if you think this is a mistake.")}
      </p>
    </div>
  );
}

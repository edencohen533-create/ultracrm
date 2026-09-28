import { serverT } from "@/lib/i18n-server";

export async function ComingSoon({ title }: { title: string }) {
  const t = await serverT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{t("בבנייה — יתווסף בשלב הבא.", "Under construction — coming in the next phase.")}</p>
    </div>
  );
}

import { db } from "@/lib/db";
import { maskIdentifier, verifyUnsubscribeToken } from "@/lib/unsubscribe-token";
import { UnsubscribeForm } from "./unsubscribe-form";

export const dynamic = "force-dynamic";

/** Public page (no login): confirm unsubscribe from ALL marketing of this business. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = verifyUnsubscribeToken(token);
  const business = p ? await db.business.findFirst({ where: { id: p.b, isActive: true }, select: { name: true } }) : null;
  const valid = Boolean(p && business);
  const already = p ? await db.suppression.findFirst({ where: { businessId: p.b, identifier: p.i, revokedAt: null }, select: { id: true } }) : null;
  return (
    <main dir="rtl" lang="he" className="min-h-screen bg-[#f4f4f7] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm text-gray-900">
        <h1 className="text-xl font-semibold mb-2">הסרה מרשימת התפוצה</h1>
        {!valid ? (
          <p className="text-sm text-gray-600">הקישור אינו תקף או שפג תוקפו. ניתן להשיב &quot;הסר&quot; להודעה שקיבלתם או לפנות לעסק ישירות.</p>
        ) : (
          <UnsubscribeForm token={token} business={business!.name} identifier={maskIdentifier(p!.i)} already={Boolean(already)} />
        )}
      </div>
    </main>
  );
}

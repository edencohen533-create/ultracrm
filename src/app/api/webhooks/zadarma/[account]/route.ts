import { NextRequest, NextResponse } from "next/server";
import { handleZadarmaWebhook } from "@/lib/telephony/zadarma-webhook";

export const dynamic = "force-dynamic";

/** Zadarma checks the URL with ?zd_echo=<value> and expects the value back (docs: "Integrations and API"). */
export async function GET(req: NextRequest) {
  const echo = req.nextUrl.searchParams.get("zd_echo");
  return echo ? new NextResponse(echo, { headers: { "content-type": "text/plain" } }) : NextResponse.json({ ok: true });
}

/** PBX call notifications (form-encoded, header "Signature"). Processing errors answer 500 so a retry can happen. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ account: string }> }) {
  const { account } = await params;
  const raw = await req.text();
  const fields = Object.fromEntries(new URLSearchParams(raw));
  try {
    const r = await handleZadarmaWebhook(account, fields, req.headers.get("signature"));
    return NextResponse.json(r.body, { status: r.status });
  } catch (err) {
    console.error("[webhook/zadarma] processing failed", err);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}

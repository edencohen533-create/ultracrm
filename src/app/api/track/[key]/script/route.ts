import { db } from "@/lib/db";
import { appBase } from "@/lib/store-urls";
export const dynamic = "force-dynamic";
/** Optional custom-site browser adapter: explicit cart activity only, never proof of payment. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const store = await db.storeConnection.findUnique({ where: { publicKey: key }, select: { platform: true, isActive: true } });
  if (!store || !store.isActive) return new Response("/* UltraCRM: inactive store */", { status: 404 });
  const js = `(function(){"use strict";var E=${JSON.stringify(`${appBase()}/api/track/${key}/events`)};
window.UltraCRM={cart:async function(cart){if(!cart||!cart.externalId)throw new Error("A stable externalId is required");var r=await fetch(E,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({},cart,{type:"cart"})),keepalive:true});if(!r.ok)throw new Error("UltraCRM cart HTTP "+r.status);return true},order:function(){throw new Error("Purchases must be sent by your server using the signed events endpoint")}};
})();`;
  return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } });
}

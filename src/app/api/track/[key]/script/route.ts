import { db } from "@/lib/db";
import { appBase } from "@/lib/store-urls";

export const dynamic = "force-dynamic";

/**
 * The site script ("הוסף אותנו לאתר"). Reads the cart the store itself exposes (Shopify /cart.js, WooCommerce Store API),
 * remembers the email/phone the visitor types, and reports cart / order events. Custom sites call
 * window.UltraCRM.cart({...}) / .order({...}) / .identify({...}) directly.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const store = await db.storeConnection.findUnique({ where: { publicKey: key }, select: { platform: true, isActive: true } });
  if (!store || !store.isActive) return new Response("/* UltraCRM: unknown or inactive store */", { status: 404, headers: { "Content-Type": "application/javascript" } });
  const endpoint = `${appBase()}/api/track/${key}/events`;
  const js = `(function(){"use strict";
var P=${JSON.stringify(store.platform)},E=${JSON.stringify(endpoint)},K="ucrm_";
function ls(k,v){try{if(v===undefined)return localStorage.getItem(K+k);localStorage.setItem(K+k,v)}catch(e){return null}}
function sid(){var s=ls("cart");if(!s){s="c_"+Math.random().toString(36).slice(2)+Date.now().toString(36);ls("cart",s)}return s}
function who(){try{return JSON.parse(ls("who")||"{}")}catch(e){return{}}}
function send(type,data){var body=JSON.stringify(Object.assign({type:type},data));try{if(navigator.sendBeacon&&type==="order"){navigator.sendBeacon(E,new Blob([body],{type:"text/plain"}));return}fetch(E,{method:"POST",body:body,headers:{"Content-Type":"text/plain"},keepalive:true,mode:"cors"}).catch(function(){})}catch(e){}}
var last="",timer=null;
function report(c){if(!c||!c.items||!c.items.length)return;var w=who();var d=Object.assign({externalId:c.externalId||sid(),email:w.email,phone:w.phone,name:w.name},c);var sig=JSON.stringify([d.externalId,d.email,d.phone,d.total,d.items.length]);if(sig===last)return;last=sig;send("cart",d)}
function shopify(){return fetch("/cart.js",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(c){return{externalId:c.token,currency:c.currency,total:(c.total_price||0)/100,checkoutUrl:location.origin+"/cart",items:(c.items||[]).map(function(i){return{name:i.product_title||i.title,quantity:i.quantity,price:(i.final_price||i.price||0)/100,url:i.url?location.origin+i.url:undefined,image:i.image}})}})}
function woo(){return fetch("/wp-json/wc/store/v1/cart",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(c){var m=Math.pow(10,(c.totals&&c.totals.currency_minor_unit)||2);var b=c.billing_address||{};var w=who();if(b.email&&!w.email)remember({email:b.email});if(b.phone&&!w.phone)remember({phone:b.phone});return{externalId:sid(),currency:c.totals&&c.totals.currency_code,total:c.totals?Number(c.totals.total_price)/m:undefined,checkoutUrl:location.origin+"/checkout/",items:(c.items||[]).map(function(i){return{name:i.name,quantity:i.quantity,price:i.prices?Number(i.prices.price)/m:undefined,url:i.permalink,image:i.images&&i.images[0]&&i.images[0].src}})}})}
function poll(){var f=P==="shopify"?shopify:P==="woocommerce"?woo:null;if(!f)return;f().then(report).catch(function(){})}
function remember(x){var w=who();for(var k in x)if(x[k])w[k]=String(x[k]).slice(0,200);ls("who",JSON.stringify(w));clearTimeout(timer);timer=setTimeout(function(){last="";poll();if(window.__ucrmCart)report(window.__ucrmCart)},800)}
document.addEventListener("change",function(e){var t=e.target;if(!t||!t.name&&!t.type)return;var n=((t.name||"")+" "+(t.id||"")+" "+(t.type||"")+" "+(t.autocomplete||"")).toLowerCase();var v=(t.value||"").trim();if(!v)return;if(n.indexOf("email")>-1&&v.indexOf("@")>0)remember({email:v});else if(/phone|tel/.test(n)&&/\\d{6,}/.test(v.replace(/\\D/g,"")))remember({phone:v});else if(/first_?name|full_?name|billing_first/.test(n))remember({name:v})},true);
var m=location.pathname.match(/order-received\\/(\\d+)/);if(P==="woocommerce"&&m){var w=who();send("order",{orderId:m[1],externalId:sid(),email:w.email,phone:w.phone});ls("cart","")}
if(P==="shopify"&&window.Shopify&&window.Shopify.checkout&&window.Shopify.checkout.order_id){var sc=window.Shopify.checkout;send("order",{orderId:String(sc.order_id),email:sc.email,phone:sc.phone,total:Number(sc.total_price)})}
window.UltraCRM={cart:function(c){window.__ucrmCart=c;last="";report(c)},order:function(o){send("order",Object.assign({externalId:sid()},o));ls("cart","")},identify:function(x){remember(x||{})}};
poll();setInterval(poll,20000);document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")poll()});
})();`;
  return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}

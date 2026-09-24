import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const url = new URL(process.env.DATABASE_URL_UNPOOLED!); const schema = url.searchParams.get("schema")!; url.searchParams.delete("schema");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });
(async () => {
  await p.telephonyEvent.deleteMany({}); await p.task.deleteMany({}); await p.noteDraft.deleteMany({}); await p.call.deleteMany({}); await p.dialerSession.deleteMany({}); await p.dncEntry.deleteMany({}); await p.auditLog.deleteMany({});
  await p.listLead.updateMany({ data: { status: "pending", attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null, nextAttemptAt: null, lastAttemptAt: null, lastOutcome: null, preferredUserId: null } });
  await p.user.updateMany({ data: { presence: "offline" } });
  console.log("reset done"); await p.$disconnect();
})();

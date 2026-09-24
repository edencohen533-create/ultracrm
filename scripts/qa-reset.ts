import { prisma } from "../src/lib/db";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.QA_LOCAL !== "1" || url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/dialer_qa" || process.env.TELEPHONY_PROVIDER !== "mock") throw new Error("Reset is restricted to the isolated local QA database");
  const ids = (await prisma.business.findMany({ where: { slug: { in: ["demo", "qa-b"] } }, select: { id: true } })).map(b => b.id);
  const where = { businessId: { in: ids } };
  await prisma.$transaction(async tx => {
    await tx.callMonitor.deleteMany({ where });
    await tx.telephonyEvent.deleteMany({ where });
    await tx.task.deleteMany({ where });
    await tx.noteDraft.deleteMany({ where });
    await tx.call.deleteMany({ where });
    await tx.listLead.deleteMany({ where });
    await tx.dialListAgent.deleteMany({ where: { list: where } });
    await tx.dialerSession.deleteMany({ where });
    await tx.dialList.deleteMany({ where });
    await tx.dncEntry.deleteMany({ where });
    await tx.contact.deleteMany({ where });
    await tx.phoneNumber.deleteMany({ where });
    await tx.script.deleteMany({ where });
    await tx.auditLog.deleteMany({ where });
    await tx.user.updateMany({ where, data: { teamId: null } });
    await tx.team.deleteMany({ where });
    await tx.user.deleteMany({ where });
    await tx.business.deleteMany({ where: { id: { in: ids } } });
  });
  await prisma.$disconnect();
  for (const script of ["prisma/seed.ts", "scripts/qa-seed.ts"]) {
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", script], { env: process.env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    if (script.includes("qa-seed")) fs.writeFileSync(process.env.QA_IDS!, r.stdout.trim().split("\n").at(-1)!);
  }
  console.log("Reset only local demo/qa-b fixtures; ready for a fresh full API or browser run.");
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode=1; });

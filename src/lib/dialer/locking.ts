import { Prisma } from "@/generated/prisma/client";
import { dbSchema } from "@/lib/db";

/** Serialize short DB mutations for one agent across tabs and server processes. */
export async function lockAgent(tx: Prisma.TransactionClient, userId: string) {
  const table = Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."users"`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${table} WHERE id = ${userId} FOR UPDATE`);
}

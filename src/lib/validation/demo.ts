import { z } from "zod";
import { MessageType } from "@/generated/prisma/client";

export const simulateInboundSchema = z.object({
  contactId: z.string().min(1, "יש לבחור איש קשר"),
  body: z.string().min(1, "יש להזין תוכן הודעה"),
  type: z.enum(MessageType).default(MessageType.TEXT),
});

export type SimulateInboundInput = z.infer<typeof simulateInboundSchema>;

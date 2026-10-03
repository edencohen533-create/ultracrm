import { z } from "zod";

export const textInsightSchema = z.object({
  kind: z.enum(["opening", "discovery", "objection", "offer", "closing", "improvement"]),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(1200),
  objection: z.string().trim().max(400).optional(),
});

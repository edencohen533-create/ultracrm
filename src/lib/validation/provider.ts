import { z } from "zod";

export const metaProviderConfigSchema = z.object({
  accessToken: z.string().min(1, "נא להזין Access Token"),
  phoneNumberId: z.string().regex(/^\d+$/, "Phone Number ID חייב להכיל ספרות בלבד"),
  businessAccountId: z.string().regex(/^\d+$/, "Business Account ID חייב להכיל ספרות בלבד"),
  webhookVerifyToken: z.string().min(1, "נא להזין Webhook Verify Token"),
  appSecret: z.string().trim().min(1, "App Secret נדרש לאימות הודעות נכנסות"),
});

export type MetaProviderConfigInput = z.infer<typeof metaProviderConfigSchema>;

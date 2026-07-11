import { z } from "zod";

export const trafficReceiptSchema = z
  .object({
    eventId: z.string().uuid(),
    instanceId: z.string().min(1),
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict();

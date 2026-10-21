import { z } from "zod";

export const retentionSchema = z
  .object({
    historyDays: z.number().int().min(0).max(3650).default(0),
    commandDays: z.number().int().min(0).max(3650).default(0),
    batchSize: z.number().int().min(1).max(1000).default(100),
    dryRun: z.boolean().default(true),
  })
  .refine(
    (value) =>
      value.commandDays === 0 || value.commandDays >= value.historyDays,
    "Срок дедупликации команд должен быть не меньше срока истории",
  );
export type RetentionOptions = z.input<typeof retentionSchema>;

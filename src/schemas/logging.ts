import { z } from "zod";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ActionLogEntrySchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  result: z.union([z.record(z.string(), z.unknown()), z.string(), z.null()]).optional(),
  error: z.string().optional(),
  duration_ms: z.number().optional(),
  success: z.boolean(),
});
export type ActionLogEntry = z.infer<typeof ActionLogEntrySchema>;

export interface ActionLogRecord extends ActionLogEntry {
  timestamp: string;
}

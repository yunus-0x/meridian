import { z } from "zod";

export const CliSubcommandSchema = z.enum([
  "start",
  "status",
  "balance",
  "positions",
  "pnl",
  "screen",
  "pool",
  "active-bin",
  "manage",
  "close",
  "claim",
  "swap",
  "wallets",
  "blacklist",
  "performance",
  "config",
  "help",
]);
export type CliSubcommand = z.infer<typeof CliSubcommandSchema>;

export const CliFlagsSchema = z.object({
  wallet: z.string().optional(),
  name: z.string().optional(),
  pool: z.string().optional(),
  position: z.string().optional(),
  mint: z.string().optional(),
  reason: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  amount: z.string().optional(),
  hours: z.string().optional(),
  help: z.boolean().optional(),
  "dry-run": z.boolean().optional(),
  "skip-swap": z.boolean().optional(),
});
export type CliFlags = z.infer<typeof CliFlagsSchema>;

export const MonitorStatusOutputSchema = z.object({
  started: z.boolean().optional(),
  shadow: z.boolean(),
  wallets: z.record(z.unknown()).optional(),
  pending_transactions: z.number().optional(),
  signals: z.record(z.unknown()).optional(),
  attempts: z.record(z.unknown()).optional(),
});
export type MonitorStatusOutput = z.infer<typeof MonitorStatusOutputSchema>;

export const ConfigCliOutputSchema = z.object({
  shadowMode: z.boolean(),
  risk: z.record(z.unknown()),
  screening: z.record(z.unknown()),
  management: z.record(z.unknown()),
  strategy: z.record(z.unknown()),
  schedule: z.record(z.unknown()),
});
export type ConfigCliOutput = z.infer<typeof ConfigCliOutputSchema>;

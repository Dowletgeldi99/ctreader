import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional().or(z.literal("")),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional().or(z.literal("")),
  TELEGRAM_MODE: z.enum(["disabled", "polling", "webhook"]).default("disabled"),
  ADMIN_API_KEY: z.string().min(32),
  AGENT_TOKEN_PEPPER: z.string().min(32),
  ALLOW_REAL_TRADING: booleanFromString,
  TRADING_KILL_SWITCH: booleanFromString,
  MAX_RISK_PERCENT: z.coerce.number().positive().max(5).default(0.5),
  MAX_DAILY_LOSS_PERCENT: z.coerce.number().positive().max(20).default(1),
  MAX_FIXED_LOT: z.coerce.number().positive().max(100).default(1),
  MAX_OPEN_POSITIONS_PER_USER: z.coerce.number().int().positive().max(100).default(10),
  CTRADER_MARGIN_BUFFER_PERCENT: z.coerce.number().min(0).max(500).default(25),
  CTRADER_JOB_LEASE_SECONDS: z.coerce.number().int().min(15).max(300).default(45),
  PAIRING_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  CBOT_INSTALL_URL: z.string().url().optional().or(z.literal("")),
  SUBSCRIPTIONS_ENFORCED: booleanFromString,
  TELEGRAM_ADMIN_IDS: z.string().default(""),
  CTRADER_ENABLED: booleanFromString,
  CTRADER_MOCK_MODE: booleanFromString,
  CTRADER_CLIENT_ID: z.string().min(1).optional().or(z.literal("")),
  CTRADER_CLIENT_SECRET: z.string().min(1).optional().or(z.literal("")),
  CTRADER_REDIRECT_URI: z.string().url().optional().or(z.literal("")),
  CTRADER_TOKEN_ENCRYPTION_KEY: z.string().optional().or(z.literal("")),
}).superRefine((environment, context) => {
  if (!environment.CTRADER_ENABLED) return;

  for (const field of [
    "CTRADER_CLIENT_ID",
    "CTRADER_CLIENT_SECRET",
    "CTRADER_REDIRECT_URI",
    "CTRADER_TOKEN_ENCRYPTION_KEY",
  ] as const) {
    if (!environment[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when CTRADER_ENABLED=true`,
      });
    }
  }

  const key = environment.CTRADER_TOKEN_ENCRYPTION_KEY;
  if (key && Buffer.from(key, "base64").length !== 32) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CTRADER_TOKEN_ENCRYPTION_KEY"],
      message: "CTRADER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    });
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  return environmentSchema.parse(input);
}

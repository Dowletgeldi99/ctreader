import { describe, expect, it, vi } from "vitest";
import { CTraderExecutionService } from "../src/ctrader/ctrader-execution.service";

describe("cTrader distributed execution claim", () => {
  it("starts one job only once when two backend workers poll together", async () => {
    let claimed = false;
    const job = {
      id: "00000000-0000-4000-8000-000000000001",
      status: "SCHEDULED",
      executionVenue: "CTRADER",
      executeAt: new Date(Date.now() + 5_000),
      expiresAt: new Date(Date.now() + 60_000),
      armSeconds: 10,
    };
    const prisma = {
      tradeJob: {
        findMany: vi.fn(async () => [job]),
        updateMany: vi.fn(async ({ where }: { where: { status?: string } }) => {
          if (where.status === "SCHEDULED" && !claimed) { claimed = true; return { count: 1 }; }
          return { count: 0 };
        }),
      },
      executionReport: { upsert: vi.fn(async () => ({})) },
    };
    const config = { get: vi.fn((key: string) => ({
      CTRADER_ENABLED: true, CTRADER_MOCK_MODE: false, ALLOW_REAL_TRADING: false,
      CTRADER_JOB_LEASE_SECONDS: 45, MAX_OPEN_POSITIONS_PER_USER: 10,
      CTRADER_MARGIN_BUFFER_PERCENT: 25, MAX_RISK_PERCENT: 0.5,
    })[key]) };
    const safety = { assertTradingOpen: vi.fn(async () => undefined) };
    const first = new CTraderExecutionService(prisma as never, {} as never, safety as never, config as never);
    const second = new CTraderExecutionService(prisma as never, {} as never, safety as never, config as never);
    const starts = vi.fn(async () => undefined);
    (first as unknown as { start: typeof starts }).start = starts;
    (second as unknown as { start: typeof starts }).start = starts;

    await Promise.all([
      (first as unknown as { tick(): Promise<void> }).tick(),
      (second as unknown as { tick(): Promise<void> }).tick(),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(starts).toHaveBeenCalledTimes(1);
  });
});

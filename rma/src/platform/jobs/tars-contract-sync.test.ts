import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, ensureQueues } = vi.hoisted(() => ({ send: vi.fn(), ensureQueues: vi.fn() }));
vi.mock("./boss", () => ({ boss: { send }, ensureQueues }));
vi.mock("@/platform/integrations/tars/session-store", () => ({ loadSession: vi.fn() }));
vi.mock("@/modules/rental/contract-documents", () => ({ syncTarsRentalContract: vi.fn() }));

import { scheduleClosedTarsContractSync, TARS_CLOSED_CONTRACT_DELAY_SECONDS } from "./tars-contract-sync";
import { TARS_CONTRACT_SYNC_QUEUE } from "./queues";

const data = {
  tenantId: "9f4c0335-a97a-4817-809a-138a0d333c69",
  rentalId: "36acba19-1bdd-4bc2-a9c5-c287478d74a3",
  actorId: "fa354121-1969-489a-901b-d18a4ca1f822",
};

describe("closed TARS contract sync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues one final-PDF download five minutes after closure", async () => {
    await scheduleClosedTarsContractSync(data);
    expect(ensureQueues).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(TARS_CONTRACT_SYNC_QUEUE, data, {
      startAfter: TARS_CLOSED_CONTRACT_DELAY_SECONDS,
      singletonKey: `closed-contract:${data.rentalId}`,
    });
    expect(TARS_CLOSED_CONTRACT_DELAY_SECONDS).toBe(300);
  });
});

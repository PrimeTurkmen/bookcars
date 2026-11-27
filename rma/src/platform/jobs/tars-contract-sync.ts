import { boss, ensureQueues } from "./boss";
import { TARS_CONTRACT_SYNC_QUEUE } from "./queues";
import { log } from "@/platform/log";
import { syncTarsRentalContract } from "@/modules/rental/contract-documents";
import { TarsClient } from "@/platform/integrations/tars/client";
import { loadSession } from "@/platform/integrations/tars/session-store";

export const TARS_CLOSED_CONTRACT_DELAY_SECONDS = 5 * 60;

type ContractSyncJob = { tenantId: string; rentalId: string; actorId: string | null };

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function jobData(value: unknown): ContractSyncJob {
  if (!value || typeof value !== "object") throw new Error("Invalid TARS contract sync job");
  const data = value as Record<string, unknown>;
  return {
    tenantId: uuid(data.tenantId, "tenantId"),
    rentalId: uuid(data.rentalId, "rentalId"),
    actorId: data.actorId === null ? null : uuid(data.actorId, "actorId"),
  };
}

export async function scheduleClosedTarsContractSync(data: ContractSyncJob): Promise<void> {
  await ensureQueues();
  await boss.send(TARS_CONTRACT_SYNC_QUEUE, data, {
    startAfter: TARS_CLOSED_CONTRACT_DELAY_SECONDS,
    singletonKey: `closed-contract:${data.rentalId}`,
  });
}

export function startTarsContractSyncWorker(): Promise<string> {
  return boss.work(TARS_CONTRACT_SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = jobData(job.data);
      const session = loadSession();
      if (!session) throw new Error("No authenticated TARS session is available for the closed-contract sync");
      const client = new TarsClient({
        orgDid: process.env.TARS_ORG_DID?.trim() || "did:rta:51646245",
        cookieHeader: session.cookieHeader,
        baseUrl: process.env.TARS_BASE_URL?.trim() || "https://tars.rta.ae",
      });
      const result = await syncTarsRentalContract({ ...data, client, replaceExisting: true });
      log.info("closed TARS contract synced", { rentalId: data.rentalId, created: result.created });
    }
  });
}

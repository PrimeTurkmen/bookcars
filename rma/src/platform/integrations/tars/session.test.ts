import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFilePath } from "./session-store";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("TARS session path in the Next.js runtime", () => {
  it("uses the application working directory without import.meta.dirname", () => {
    vi.stubEnv("TARS_SESSION_FILE", "");
    vi.spyOn(process, "cwd").mockReturnValue("/opt/rma-crm/platform");
    expect(sessionFilePath()).toBe("/opt/rma-crm/platform/.tars-session.json");
  });
});

// TARS session management.
//
// A TARS "session" is the cookie jar the RTA SSO login (login.rta.ae, Oracle
// Access Manager OAuth2 + OTP) sets on tars.rta.ae: `access_token` (JWT, 1h
// TTL), `session`, plus F5 WAF cookies (TS*). The jar is persisted to a
// gitignored file so repeat syncs within the hour reuse it instead of
// re-logging in (every login costs an SMS/email OTP).
//
// SECURITY: this module NEVER logs passwords, tokens, or cookie values — only
// cookie NAMES and expiry timestamps. The session file itself is gitignored
// and outside the repo's served roots.
//
// The OTP step is deliberately pluggable: `getOtp` is a callback so a future
// email-OTP poller (the code lands in the operator's mailbox) can replace the
// manual file flow without touching the login sequence. The default provider
// polls a file the operator writes by hand.

import { existsSync, readFileSync } from "node:fs";
import { loadSession, saveSession, type LoadedSession, type TarsCookie } from "./session-store";

export { clearSession, loadSession, saveSession, sessionFilePath } from "./session-store";
export type { LoadedSession, TarsCookie } from "./session-store";

const DEFAULT_OTP_FILE = "/tmp/tars-otp.txt";
const OTP_WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Default OTP provider: polls a file (TARS_OTP_FILE, default /tmp/tars-otp.txt)
 * until the operator writes the SMS/email code into it. Manual-run friendly;
 * swap for an email poller when the OTP mailbox is automated.
 */
export function fileOtpProvider(
  file = process.env.TARS_OTP_FILE?.trim() || DEFAULT_OTP_FILE,
  timeoutMs = OTP_WAIT_TIMEOUT_MS,
): () => Promise<string> {
  return async () => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(file)) {
        const code = readFileSync(file, "utf8").trim();
        if (/^\d{4,8}$/.test(code)) return code;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`OTP timeout — no code appeared in ${file} within ${timeoutMs / 60000} min`);
  };
}

export interface TarsLoginOptions {
  username: string;
  password: string;
  /** Called once the SSO page has dispatched the OTP. */
  getOtp: () => Promise<string>;
  /** Which channel to request the OTP on (default email). */
  otpChannel?: "email" | "mobile";
  headless?: boolean;
}

/**
 * Full SSO login via real Chrome (F5 WAF fingerprinting makes a headless-shell
 * client unreliable). Refactored from scripts/tars-probe-login.ts, which proved
 * this sequence live on 2026-10-23. Returns the tars.rta.ae cookie jar.
 *
 * Playwright is imported dynamically so this module stays import-safe for the
 * Next.js server bundle and for workers that never log in.
 */
export async function loginWithPlaywright(opts: TarsLoginOptions): Promise<TarsCookie[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: opts.headless ?? true, channel: "chrome" });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();

    await page.goto("https://tars.rta.ae/apps/business/en/rentals", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
    await page.locator('a:has-text("Login")').first().click();
    await page.waitForTimeout(4000);

    const credForm = page.locator('form[action*="auth_cred_submit"]').first();
    await credForm.locator('input[name="username"]').fill(opts.username);
    await credForm.locator('input[name="password"]').fill(opts.password);
    const submitBtn = credForm
      .locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign")')
      .first();
    await submitBtn.click().catch(async () => {
      await credForm.locator('input[name="password"]').press("Enter");
    });
    await page.waitForTimeout(6000);

    const text = await page.locator("body").innerText();
    if (!text.includes("Send OTP")) {
      throw new Error(
        `TARS login: unexpected page after credentials (${page.url()}): ${text.slice(0, 200)}`,
      );
    }

    const channel = opts.otpChannel ?? process.env.TARS_OTP_CHANNEL ?? "email";
    // The OTP screen is a radio group `name="sfaChoice"`: value="mobile" (SMS,
    // pre-selected) and value="mail" (email). Clicking the label text does NOT
    // toggle the radio (probed 2026-11-19), so check the input directly.
    const radioValue = channel === "email" ? "mail" : "mobile";
    await page.locator(`input[name="sfaChoice"][value="${radioValue}"]`).check();
    await page.locator('button:has-text("Send OTP")').first().click();

    const otpInput = page
      .locator('input#passcode:visible, input[name="passcode"]:visible, input[placeholder*="OTP" i]:visible')
      .first();
    try {
      await otpInput.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      const inputs = await page.locator("input").evaluateAll((nodes) =>
        nodes.map((node) => ({
          type: node.getAttribute("type"),
          name: node.getAttribute("name"),
          id: node.getAttribute("id"),
          visible: Boolean((node as HTMLElement).offsetParent),
        })),
      );
      throw new Error(`TARS login: OTP input not found at ${page.url()}; inputs ${JSON.stringify(inputs)}`);
    }
    const otp = await opts.getOtp();
    await otpInput.fill(otp);
    await page.locator('button#btn_mfa_login:visible, button:has-text("Verify"):visible').first().click();
    await page.locator("#passcode").waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
    if (await page.locator("#passcode:visible").count()) {
      const text = await page.locator("body").innerText();
      throw new Error(`TARS login: OTP was not accepted: ${text.slice(0, 500)}`);
    }

    // Consent page, if shown.
    for (let i = 0; i < 3 && !page.url().includes("tars.rta.ae"); i++) {
      const approve = page
        .locator('button:has-text("Allow"), button:has-text("Approve"), input[type="submit"]:visible')
        .first();
      if (await approve.count()) {
        await approve.click().catch(() => {});
        await page.waitForTimeout(5000);
      } else break;
    }
    await page.waitForTimeout(3000);

    if (!page.url().includes("tars.rta.ae")) {
      throw new Error(`TARS login: ended on ${page.url()} instead of tars.rta.ae — login failed`);
    }

    const cookies = (await ctx.cookies("https://tars.rta.ae")) as TarsCookie[];
    if (!cookies.some((c) => c.name === "access_token")) {
      throw new Error("TARS login completed but no access_token cookie was set");
    }
    return cookies;
  } finally {
    await browser.close();
  }
}

export interface EnsureSessionOptions {
  getOtp?: () => Promise<string>;
  otpChannel?: "email" | "mobile";
  headless?: boolean;
}

/**
 * Hand the caller a valid cookie header: reuse the saved jar when the
 * access_token has >5 min left, otherwise run the full SSO login (needs
 * TARS_USERNAME / TARS_PASSWORD in env) and persist the fresh jar.
 */
export async function ensureSession(opts: EnsureSessionOptions = {}): Promise<LoadedSession> {
  const cached = loadSession();
  if (cached) return cached;

  const username = process.env.TARS_USERNAME;
  const password = process.env.TARS_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "TARS session expired/absent and TARS_USERNAME / TARS_PASSWORD are not set — cannot re-login.",
    );
  }

  console.log(
    `[tars] No usable session — starting SSO login. When the OTP arrives, ` +
      `write it to ${process.env.TARS_OTP_FILE?.trim() || DEFAULT_OTP_FILE}`,
  );
  const cookies = await loginWithPlaywright({
    username,
    password,
    getOtp: opts.getOtp ?? fileOtpProvider(),
    otpChannel: opts.otpChannel,
    headless: opts.headless,
  });
  saveSession(cookies);

  const fresh = loadSession();
  if (!fresh) throw new Error("TARS login succeeded but the saved session did not validate");
  return fresh;
}

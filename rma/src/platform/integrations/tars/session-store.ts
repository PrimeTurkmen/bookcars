import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface TarsCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
}

interface SessionFile {
  savedAt: string;
  url?: string;
  cookies: TarsCookie[];
}

const MIN_TTL_MS = 5 * 60_000;

export function sessionFilePath(): string {
  return process.env.TARS_SESSION_FILE?.trim() || resolve(process.cwd(), ".tars-session.json");
}

function jwtExpiryMs(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export interface LoadedSession {
  cookieHeader: string;
  expiresAtMs: number;
}

export function loadSession(path = sessionFilePath()): LoadedSession | null {
  let parsed: SessionFile;
  try {
    if (!existsSync(path)) return null;
    parsed = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  } catch {
    return null;
  }
  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  if (cookies.length === 0) return null;
  const token = cookies.find((c) => c.name === "access_token");
  if (!token) return null;
  const expiresAtMs = jwtExpiryMs(token.value);
  if (!expiresAtMs || expiresAtMs - Date.now() < MIN_TTL_MS) return null;
  return {
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    expiresAtMs,
  };
}

export function saveSession(cookies: TarsCookie[], url?: string, path = sessionFilePath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload: SessionFile = { savedAt: new Date().toISOString(), url, cookies };
  writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
}

export function clearSession(path = sessionFilePath()): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

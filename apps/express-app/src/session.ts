import type { SessionData } from "./types.js";

async function key(secret: string) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSession(data: SessionData, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(JSON.stringify(data)));
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}
export async function decryptSession(value: string, secret: string): Promise<SessionData> {
  const [iv, encrypted] = value.split(".");
  if (!iv || !encrypted) throw new Error("Invalid session ciphertext");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url") }, await key(secret), Buffer.from(encrypted, "base64url"));
  return JSON.parse(new TextDecoder().decode(plaintext)) as SessionData;
}
export const COOKIE_CHUNK_SIZE = 3000;
export const MAX_COOKIE_CHUNKS = 4;
export class CookieSession {
  data: SessionData = {};
  private expiresAt = 0;
  private changed = false;
  private cleared = false;
  constructor(private secret: string, private now = () => Date.now()) {}
  async load(token: string | undefined) {
    if (!token) return;
    try {
      if (token.length > COOKIE_CHUNK_SIZE * MAX_COOKIE_CHUNKS) throw new Error("Session too large");
      const envelope = await decryptSession(token, this.secret) as SessionData & { expiresAt?: number };
      if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt! <= this.now()) throw new Error("Session expired");
      this.expiresAt = envelope.expiresAt!;
      const { expiresAt: _, ...data } = envelope;
      this.data = data;
    } catch { await this.destroy(); }
  }
  async rotate() {
    this.data = {};
    this.expiresAt = this.now() + 3600_000;
    this.changed = true;
    this.cleared = false;
  }
  touch() { this.changed = true; }
  async destroy() { this.data = {}; this.expiresAt = 0; this.changed = false; this.cleared = true; }
  async save(): Promise<{ token?: string; cleared: boolean; maxAge?: number }> {
    if (!this.changed) return { cleared: this.cleared };
    if (this.expiresAt <= this.now()) { await this.destroy(); return { cleared: true }; }
    const token = await encryptSession({ ...this.data, expiresAt: this.expiresAt } as SessionData, this.secret);
    if (token.length > COOKIE_CHUNK_SIZE * MAX_COOKIE_CHUNKS) throw new Error("Session exceeds cookie size limit");
    return { token, cleared: false, maxAge: Math.max(1, Math.ceil((this.expiresAt - this.now()) / 1000)) };
  }
}

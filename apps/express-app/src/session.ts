import type { PoolClient } from "pg";
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
async function hash(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
}
export class DatabaseSession {
  data: SessionData = {};
  private id?: string;
  private token?: string;
  private changed = false;
  private cleared = false;
  constructor(private client: PoolClient, private secret: string) {}
  async load(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    this.id = await hash(token);
    // Serialize refresh, callback, and logout for the same session across isolates.
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [this.id]);
    const result = await this.client.query<{ data: string }>("SELECT data FROM auth.app_b_session WHERE id = $1 AND expires_at > now() FOR UPDATE", [this.id]);
    if (result.rows[0]) {
      try { this.data = await decryptSession(result.rows[0].data, this.secret); }
      catch { await this.destroy(); }
    }
  }
  async rotate() {
    await this.destroy();
    this.cleared = false;
    this.token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.id = await hash(this.token);
    this.changed = true;
  }
  touch() { this.changed = true; }
  async destroy() {
    if (this.id) await this.client.query("DELETE FROM auth.app_b_session WHERE id = $1", [this.id]);
    this.id = undefined; this.token = undefined; this.data = {}; this.changed = false; this.cleared = true;
  }
  async save(): Promise<{ token?: string; cleared: boolean }> {
    if (this.changed && this.id) {
      const data = await encryptSession(this.data, this.secret);
      if (this.token) await this.client.query("INSERT INTO auth.app_b_session (id, data, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [this.id, data]);
      else await this.client.query("UPDATE auth.app_b_session SET data = $2 WHERE id = $1 AND expires_at > now()", [this.id, data]);
    }
    return { token: this.token, cleared: this.cleared };
  }
}

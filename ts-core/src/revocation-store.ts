import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Seconds a revocation outlives its token's `exp`. Oathweave tokens are accepted up to the
 * configured clock tolerance (at most 60 s) after `exp`, so the entry must stay that long.
 */
export const REVOCATION_RETAIN_AFTER_EXPIRY_SEC = 60;

export class TokenRevocationStore {
  private readonly revoked = new Map<string, number>();

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    try {
      const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      for (const [jti, exp] of Object.entries(value)) {
        if (typeof exp === "number" && Number.isFinite(exp)) this.revoked.set(jti, exp);
      }
      this.removeExpired(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  has(jti: string): boolean {
    const expiresAt = this.revoked.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt + REVOCATION_RETAIN_AFTER_EXPIRY_SEC <= Math.floor(Date.now() / 1000)) {
      this.revoked.delete(jti);
      this.persist();
      return false;
    }
    return true;
  }

  add(jti: string, expiresAt: number): void {
    this.revoked.set(jti, expiresAt);
    this.removeExpired(false);
    this.persist();
  }

  private removeExpired(persist = true): void {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const [jti, exp] of this.revoked) {
      if (exp + REVOCATION_RETAIN_AFTER_EXPIRY_SEC <= now) {
        this.revoked.delete(jti);
        changed = true;
      }
    }
    if (changed && persist) this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.revoked), null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

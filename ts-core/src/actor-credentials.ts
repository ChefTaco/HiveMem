import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';

/** The longest time a renewal keeps the previous credential working, so its holder can switch over. */
export const MAX_RENEWAL_GRACE_SECONDS = 86_400;
export const DEFAULT_RENEWAL_GRACE_SECONDS = 3_600;

/**
 * Product-owned request. Absolute deadlines survive coordinator retries and
 * rotation; only an explicit `renew` of an active agent sets a new one.
 */
export const actorCredentialSchema = z.object({
  action: z.enum(['enroll', 'rotate', 'renew', 'disable']),
  agent_id: z.string().min(2).max(32).regex(/^[a-z0-9_-]+$/),
  display_name: z.string().min(2).max(128),
  description: z.string().max(512).default(''),
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/)).min(1).max(50)
    .refine(values => values.every(value => !value.startsWith('admin:')), 'Agent permissions must be explicit and non-admin'),
  workspace_id: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  expires_at: z.iso.datetime(),
  /** renew only: seconds the previous credential keeps working (default one hour, at most one day). */
  grace_seconds: z.number().int().min(0).max(MAX_RENEWAL_GRACE_SECONDS).optional(),
}).strict().refine(value => value.grace_seconds === undefined || value.action === 'renew', { message: 'grace_seconds belongs to renew', path: ['grace_seconds'] });
export type ActorCredentialRequest = z.infer<typeof actorCredentialSchema>;
export const actorCredentialDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function actorReceiptCipher(secret: string) {
  const key = scryptSync(secret, 'hivemem-actor-receipt-v1', 32);
  return {
    encrypt(value: string): string {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map(part => part.toString('hex')).join(':');
    },
    decrypt(value: string): string {
      const parts = value.split(':');
      if (parts.length !== 3) throw new Error('Invalid actor receipt envelope');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0]!, 'hex'));
      cipher.setAuthTag(Buffer.from(parts[1]!, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(parts[2]!, 'hex')), cipher.final()]).toString('utf8');
    },
  };
}

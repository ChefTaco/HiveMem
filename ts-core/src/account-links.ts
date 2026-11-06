import { z } from "zod";

const link = z
  .object({
    issuer: z.url(),
    subject: z.string().min(1).max(256),
    localId: z.string().min(1).max(256),
    credentialGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export function parseAccountLinks(raw: string) {
  const links = z.array(link).max(10000).parse(JSON.parse(raw));
  const seen = new Set<string>();
  for (const item of links) {
    const key = JSON.stringify([item.issuer, item.subject]);
    if (seen.has(key)) throw new Error("Duplicate issuer/subject account link");
    seen.add(key);
  }
  return links;
}
export type AccountLink = z.infer<typeof link>;
export function linkedLocalId(
  links: readonly AccountLink[],
  identity: { issuer: string; subject: string },
): string {
  return linkedAccount(links, identity).localId;
}
export function linkedAccount(
  links: readonly AccountLink[],
  identity: { issuer: string; subject: string },
): AccountLink {
  const matches = links.filter(
    (link) =>
      link.issuer === identity.issuer && link.subject === identity.subject,
  );
  if (matches.length !== 1)
    throw new Error("An explicit product account link is required");
  return matches[0]!;
}

/**
 * An Oathweave service identity (a client_credentials token) one product uses
 * to call HiveMem. Each link names the exact issuer and client, the local
 * principal it acts as, and the HiveMem scopes it may ever receive.
 */
const serviceLink = z
  .object({
    issuer: z.string().min(1).max(512),
    clientId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    localId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    scopes: z.array(z.string().regex(/^[a-z0-9*-]+(?::[a-z0-9*-]+)*$/)).min(1).max(100),
  })
  .strict();
export type ServiceLink = z.infer<typeof serviceLink>;
export function parseServiceLinks(raw: string): ServiceLink[] {
  const links = z.array(serviceLink).max(100).parse(JSON.parse(raw));
  const seen = new Set<string>();
  for (const item of links) {
    const key = JSON.stringify([item.issuer, item.clientId]);
    if (seen.has(key)) throw new Error("Duplicate issuer/client service link");
    seen.add(key);
  }
  return links;
}
export function linkedService(
  links: readonly ServiceLink[],
  identity: { issuer: string; clientId: string },
): ServiceLink {
  const matches = links.filter(
    (link) => link.issuer === identity.issuer && link.clientId === identity.clientId,
  );
  if (matches.length !== 1)
    throw new Error("An explicit service link is required");
  return matches[0]!;
}

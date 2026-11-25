import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const creatorGatewayContextKey = 'altflow.creatorGateway';
const prefix = 'altflow-creator-v1.';
const segment = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const claimsSchema = z.strictObject({
  aud: z.literal('altflow-creator-v1'),
  userId: z.string().min(1).max(200),
  username: z.string().max(200),
  role: z.enum(['admin', 'user', 'creator']),
  projectId: segment,
  conversationId: segment,
  method: z.enum(['GET', 'POST', 'DELETE']),
  target: z.string().max(2048),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  exp: z.number().int(),
  nonce: z.uuid(),
  operationId: z.uuid().optional(),
  tokenBudget: z.number().int().min(262_144).max(4_194_304).optional(),
});

export type CreatorGatewayClaims = z.infer<typeof claimsSchema>;
export const creatorResourceId = (userId: string) => 'altflow-creator:' + userId;
export const creatorThreadId = (conversationId: string) => 'free:' + conversationId;

export function createCreatorGatewayVerifier(secret: string | undefined) {
  const verified = new WeakMap<Request, Promise<CreatorGatewayClaims | null>>();
  const nonces = new Map<string, number>();
  let expireAt = 0;

  async function verify(request: Request): Promise<CreatorGatewayClaims | null> {
    const authorization = request.headers.get('authorization');
    if (!secret || !authorization?.startsWith('Bearer ' + prefix)) return null;
    const [payload, signature, extra] = authorization.slice(7 + prefix.length).split('.');
    if (!payload || payload.length > 8192 || !signature || extra !== undefined) return null;
    const expected = createHmac('sha256', secret)
      .update(prefix + payload)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;
    const parsed = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    if (!parsed.success) return null;
    const claims = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request.url);
    if (
      claims.method !== request.method ||
      claims.target !== url.pathname + url.search ||
      claims.exp <= now ||
      claims.exp > now + 60
    )
      return null;
    const body = request.body ? await request.clone().arrayBuffer() : new ArrayBuffer(0);
    if (createHash('sha256').update(Buffer.from(body)).digest('hex') !== claims.sha256) return null;
    if (expireAt <= now) {
      for (const [nonce, expiry] of nonces) if (expiry <= now) nonces.delete(nonce);
      expireAt = now + 10;
    }
    if (nonces.has(claims.nonce) || nonces.size >= 20_000) return null;
    nonces.set(claims.nonce, claims.exp);
    return claims;
  }

  return (request: Request) => {
    let pending = verified.get(request);
    if (!pending) {
      pending = verify(request).catch(() => null);
      verified.set(request, pending);
    }
    return pending;
  };
}

export const isCreatorGatewayBearer = (request: Request) =>
  request.headers.get('authorization')?.startsWith('Bearer ' + prefix) ?? false;

export function creatorGatewayAllows(path: string, claims: CreatorGatewayClaims) {
  const thread = creatorThreadId(claims.conversationId);
  const agent = '/agents/creator-agent';
  const memory = '/memory/threads/' + thread;
  if (claims.method === 'GET') return path === memory || path === memory + '/messages';
  if (claims.method !== 'POST') return false;
  return path === agent + '/threads/subscribe' || path === agent + '/threads/abort';
}

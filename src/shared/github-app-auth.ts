import { createPrivateKey, sign } from 'node:crypto';

/** Authentication primitive only. Callers retain their own policy and scope gates. */
export function appJwt(appId: string, pem: Buffer | string, now: number): string {
  if (!/^[1-9]\d*$/.test(appId) || !Number.isSafeInteger(Number(appId))) throw new Error('Invalid App ID');
  if (!Number.isFinite(now) || now < 60000) throw new Error('Invalid clock');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Private key must be RSA');
  const seconds = Math.floor(now / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

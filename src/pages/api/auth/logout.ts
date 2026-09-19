import type { APIRoute } from 'astro';
import { clearSessionCookie } from '../../../lib/auth';
import { json } from '../../../lib/api';

export const POST: APIRoute = async () => {
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', clearSessionCookie());
  return res;
};

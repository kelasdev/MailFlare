import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface AccessAuthResult {
  ok: boolean;
  status: number;
  message?: string;
}

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cacheKey = teamDomain.toLowerCase();
  const cached = jwksCache.get(cacheKey);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(cacheKey, jwks);
  return jwks;
}

export async function verifyAccessJwt(
  token: string,
  env: Env
): Promise<AccessAuthResult> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return {
      ok: false,
      status: 500,
      message: "Cloudflare Access is not configured"
    };
  }

  try {
    const jwks = getJwks(env.CF_ACCESS_TEAM_DOMAIN);
    await jwtVerify(token, jwks, {
      audience: env.CF_ACCESS_AUD
    });
    return { ok: true, status: 200 };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      message: error instanceof Error ? error.message : "Invalid Access token"
    };
  }
}

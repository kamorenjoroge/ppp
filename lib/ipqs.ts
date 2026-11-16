// IPQualityScore (IPQS) IP reputation lookup — runs on the server only.
// Needs IPQS_API_KEY in .env.local (and in Vercel → Settings → Environment Variables)
//
// Settings match the IPQS website lookup page:
//   Strictness = Level 0 (Low) or Level 1 (Medium, default)
//   Allow Public Access Points = on
//   Score as mobile device = on
//   Lighter Penalties = on

export interface IpScore {
  fraudScore: number;
  proxy: boolean;
  vpn: boolean;
  tor: boolean;
  recentAbuse: boolean;
  bot: boolean;
  host?: string;
  asn?: number;
  strictness: number;
}

export type ScoreResult = { score: IpScore } | { scoreError: string };

interface IpqsResponse {
  success: boolean;
  message?: string;
  fraud_score?: number;
  proxy?: boolean;
  vpn?: boolean;
  tor?: boolean;
  recent_abuse?: boolean;
  bot_status?: boolean;
  host?: string;
  ASN?: number;
}

// Same IP + strictness is only looked up once per 30 minutes (saves IPQS credits)
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; score: IpScore }>();

export async function getIpScore(ip: string, strictness?: number): Promise<ScoreResult> {
  const key = process.env.IPQS_API_KEY;
  if (!key) return { scoreError: "No IPQS key" };

  // Only Level 0 and Level 1 are allowed
  const level = strictness === 0 || strictness === 1 ? strictness : 1;

  const cacheKey = `${ip}|${level}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return { score: hit.score };

  const params = new URLSearchParams({
    strictness: String(level),
    allow_public_access_points: "true",
    mobile: "true",
    lighter_penalties: "true",
  });

  try {
    const r = await fetch(
      `https://www.ipqualityscore.com/api/json/ip/${encodeURIComponent(key)}/${encodeURIComponent(ip)}?${params}`,
      { cache: "no-store", signal: AbortSignal.timeout(15000) }
    );
    const j = (await r.json()) as IpqsResponse;
    if (!j.success) return { scoreError: j.message || "IPQS lookup failed" };
    if (typeof j.fraud_score !== "number") return { scoreError: "IPQS returned no fraud score" };

    const score: IpScore = {
      fraudScore: j.fraud_score,
      proxy: !!j.proxy,
      vpn: !!j.vpn,
      tor: !!j.tor,
      recentAbuse: !!j.recent_abuse,
      bot: !!j.bot_status,
      host: j.host,
      asn: j.ASN,
      strictness: level,
    };
    cache.set(cacheKey, { at: Date.now(), score });
    return { score };
  } catch (e) {
    return { scoreError: e instanceof Error ? e.message : "IPQS lookup failed" };
  }
}
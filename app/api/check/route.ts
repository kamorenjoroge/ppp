import { checkProxy, type CheckResult } from "@/lib/check";
import { getIpScore } from "@/lib/ipqs";

export async function POST(req: Request): Promise<Response> {
  let result: CheckResult;
  let strictness: number | undefined;

  try {
    const body = (await req.json()) as { proxy?: string; strictness?: number };
    strictness = typeof body.strictness === "number" ? body.strictness : undefined;
    result = await checkProxy(String(body.proxy ?? ""));
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : "Check failed" };
  }

  // Only working proxies get a fraud score
  if (result.ok) {
    const s = await getIpScore(result.ip, strictness);
    return Response.json({ ...result, ...s });
  }

  return Response.json(result);
}
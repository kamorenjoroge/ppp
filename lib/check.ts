import http from "http";
import tls from "tls";

const TIMEOUT = 20000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export interface ProxyConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export type CheckResult =
  | {
      ok: true;
      ip: string;
      country?: string;
      countryCode?: string;
      region?: string;
      city?: string;
      isp?: string;
      ms: number;
    }
  | { ok: false; error: string };

interface IpApiResponse {
  status: "success" | "fail";
  message?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  isp?: string;
  query?: string;
}

export function parseProxy(line: string): ProxyConfig | null {
  const p = line.trim().split(":");
  if (p.length < 2 || !p[0] || !/^\d+$/.test(p[1])) return null;
  const [host, port, user = "", ...rest] = p;
  return { host, port: Number(port), user, pass: rest.join(":") };
}

function authHeader(px: ProxyConfig): Record<string, string> {
  return px.user
    ? { "Proxy-Authorization": "Basic " + Buffer.from(`${px.user}:${px.pass}`).toString("base64") }
    : {};
}

function statusError(code: number | undefined): Error {
  if (code === 407) return new Error("Wrong username/password (407)");
  if (code === 403) return new Error("Proxy refused (403)");
  return new Error("Proxy error HTTP " + code);
}

// Plain HTTP request through the proxy (ip-api.com — gives IP + location)
function viaHttpProxy(px: ProxyConfig, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: px.host,
        port: px.port,
        method: "GET",
        path: url,
        timeout: TIMEOUT,
        headers: { Host: u.host, "User-Agent": UA, Connection: "close", ...authHeader(px) },
      },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(d) : reject(statusError(res.statusCode))));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
    req.end();
  });
}

// HTTPS request through a CONNECT tunnel (fallback — api.ipify.org)
function viaConnect(px: ProxyConfig, host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: px.host,
      port: px.port,
      method: "CONNECT",
      path: `${host}:443`,
      timeout: TIMEOUT,
      headers: { Host: `${host}:443`, ...authHeader(px) },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(statusError(res.statusCode));
      }
      const t = tls.connect({ socket, servername: host }, () => {
        t.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nConnection: close\r\n\r\n`);
      });
      let d = "";
      t.setTimeout(TIMEOUT, () => t.destroy(new Error("Timed out")));
      t.on("data", (c: Buffer) => (d += c));
      t.on("end", () => resolve(d.split("\r\n\r\n").slice(1).join("\r\n\r\n")));
      t.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
    req.end();
  });
}

function friendly(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "Host not found";
  if (/ECONNREFUSED/.test(m)) return "Connection refused";
  if (/ECONNRESET|socket hang up/.test(m)) return "Connection dropped";
  return m;
}

export async function checkProxy(line: string): Promise<CheckResult> {
  const px = parseProxy(line);
  if (!px) return { ok: false, error: "Bad format (need HOST:PORT:USER:PASS)" };
  const start = Date.now();
  let firstErr: Error;

  try {
    const body = await viaHttpProxy(
      px,
      "http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,isp,query"
    );
    const j = JSON.parse(body) as IpApiResponse;
    if (j.status === "success" && j.query) {
      return {
        ok: true,
        ip: j.query,
        country: j.country,
        countryCode: j.countryCode,
        region: j.regionName,
        city: j.city,
        isp: j.isp,
        ms: Date.now() - start,
      };
    }
    firstErr = new Error(j.message || "Lookup failed");
  } catch (e) {
    firstErr = e instanceof Error ? e : new Error(String(e));
  }

  // Auth errors won't be fixed by retrying
  if (/407|403/.test(firstErr.message)) return { ok: false, error: friendly(firstErr) };

  try {
    const body = await viaConnect(px, "api.ipify.org", "/?format=json");
    const j = JSON.parse(body) as { ip?: string };
    if (j.ip) return { ok: true, ip: j.ip, ms: Date.now() - start };
    throw new Error("No IP returned");
  } catch {
    return { ok: false, error: friendly(firstErr) };
  }
}
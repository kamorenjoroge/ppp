"use client";

import { useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/check";
import type { IpScore } from "@/lib/ipqs";

const MAX_PROXIES = 100;

type Result = CheckResult & { score?: IpScore; scoreError?: string };

interface Item {
  line: string;
  state: "waiting" | "checking" | "done" | "stopped";
  res?: Result;
}

function scoreClass(n: number) {
  if (n >= 90) return "fs fs-high";
  if (n >= 85) return "fs fs-risky";
  if (n >= 75) return "fs fs-sus";
  return "fs fs-ok";
}

// Lower fraud score first; working without score next; dead / pending last
function rank(it: Item): number {
  const r = it.res;
  if (r?.ok && r.score) return r.score.fraudScore;
  if (r?.ok) return 1000;
  if (r) return 2000;
  return 3000;
}

function fallbackCopy(text: string) {
  const a = document.createElement("textarea");
  a.value = text;
  a.style.position = "fixed";
  a.style.opacity = "0";
  document.body.appendChild(a);
  a.select();
  try {
    document.execCommand("copy");
  } catch {
    // ignore
  }
  a.remove();
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackCopy(text);
  }
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={copied ? "copied" : undefined}
      title={text}
      onClick={async () => {
        if (!text) return;
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1100);
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(10);
  const [sortByScore, setSortByScore] = useState(true);
  const [strictness, setStrictness] = useState(1);
  const [limitError, setLimitError] = useState("");
  const stopRef = useRef(false);

  const pastedLines = useMemo(
    () => input.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    [input]
  );
  const overLimit = pastedLines.length > MAX_PROXIES;

  const update = (i: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  async function run() {
    const lines = pastedLines;
    if (!lines.length) return;
    if (lines.length > MAX_PROXIES) {
      setLimitError(
        `You pasted ${lines.length} proxies. The maximum is ${MAX_PROXIES} per check — please remove ${
          lines.length - MAX_PROXIES
        }.`
      );
      return;
    }
    setLimitError("");
    setItems(lines.map((line) => ({ line, state: "waiting" })));
    stopRef.current = false;
    setRunning(true);

    let next = 0;
    const worker = async () => {
      while (!stopRef.current && next < lines.length) {
        const i = next++;
        update(i, { state: "checking" });
        let res: Result;
        try {
          const r = await fetch("/api/check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxy: lines[i], strictness }),
          });
          res = (await r.json()) as Result;
        } catch {
          res = { ok: false, error: "Checker not running" };
        }
        update(i, { state: "done", res });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    setItems((prev) => prev.map((it) => (it.state === "waiting" ? { ...it, state: "stopped" } : it)));
    setRunning(false);
  }

  const stats = useMemo(() => {
    const done = items.filter((i) => i.state === "done");
    const ok = done.filter((i) => i.res?.ok);
    const counts: Record<string, number> = {};
    ok.forEach((i) => {
      if (i.res?.ok) counts[i.res.ip] = (counts[i.res.ip] || 0) + 1;
    });
    return { total: items.length, done: done.length, ok: ok.length, bad: done.length - ok.length, counts };
  }, [items]);

  const rows = items.map((it, n) => ({ it, n }));
  if (sortByScore) rows.sort((a, b) => rank(a.it) - rank(b.it) || a.n - b.n);
  const sortedItems = rows.map((r) => r.it);

  const workingIps = sortedItems.flatMap((i) => (i.res?.ok ? [i.res.ip] : [])).join("\n");
  const workingProxies = sortedItems.filter((i) => i.res?.ok).map((i) => i.line).join("\n");
  const deadProxies = sortedItems.filter((i) => i.res && !i.res.ok).map((i) => i.line).join("\n");

  return (
    <div className="wrap">
      <h1>Proxy Checker</h1>
      <p className="sub">
        Paste up to {MAX_PROXIES} proxies, one per line, as <code>HOST:PORT:USERNAME:PASSWORD</code>. Each one is
        tested and the table shows its <b>real exit IP</b>. The Copy button copies the full proxy string.
      </p>

      <div className="card">
        <textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setLimitError("");
          }}
          spellCheck={false}
          placeholder="91.239.130.17:44445:username:password"
        />
        <div
          style={{
            fontSize: 13,
            marginTop: 6,
            fontWeight: overLimit ? 600 : 400,
            color: overLimit ? "var(--bad)" : "var(--muted)",
          }}
        >
          {pastedLines.length} / {MAX_PROXIES} proxies
        </div>
        {limitError && (
          <div style={{ color: "var(--bad)", fontSize: 14, marginTop: 6, fontWeight: 600 }}>{limitError}</div>
        )}

        <div className="row">
          <button className="primary" onClick={run} disabled={running}>
            Check proxies
          </button>
          <button onClick={() => (stopRef.current = true)} disabled={!running}>
            Stop
          </button>
          <button
            onClick={() => {
              setInput("");
              setItems([]);
              setLimitError("");
            }}
            disabled={running}
          >
            Clear
          </button>
          <label>
            At the same time:{" "}
            <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
            </select>
          </label>
          <label>
            IPQS strictness:{" "}
            <select value={strictness} onChange={(e) => setStrictness(Number(e.target.value))} disabled={running}>
              <option value={0}>Low (Level 0)</option>
              <option value={1}>Medium (Level 1) — same as IPQS site</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={sortByScore} onChange={(e) => setSortByScore(e.target.checked)} /> Sort by
            fraud score (0 first)
          </label>
        </div>
      </div>

      <div className="card">
        <div className="stats">
          <span>
            Total: <b>{stats.total}</b>
          </span>
          <span>
            Done: <b>{stats.done}</b>
          </span>
          <span>
            Working: <b style={{ color: "var(--ok)" }}>{stats.ok}</b>
          </span>
          <span>
            Dead: <b style={{ color: "var(--bad)" }}>{stats.bad}</b>
          </span>
          <span>
            Unique IPs: <b>{Object.keys(stats.counts).length}</b>
          </span>
        </div>
        <div className="bar">
          <div style={{ width: `${stats.total ? (stats.done / stats.total) * 100 : 0}%` }} />
        </div>
        <div className="row" style={{ margin: "0 0 12px" }}>
          <CopyButton text={workingIps} label="Copy all real IPs" />
          <CopyButton text={workingProxies} label="Copy working proxies" />
          <CopyButton text={deadProxies} label="Copy dead proxies" />
        </div>

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Real IP</th>
                <th>Fraud Score</th>
                <th>Flags</th>
                <th>Location</th>
                <th>ISP</th>
                <th>Speed</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Proxy</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    Paste your proxies and click Check proxies.
                  </td>
                </tr>
              )}
              {rows.map(({ it, n }) => {
                const r = it.res;
                const dupCount = r?.ok ? stats.counts[r.ip] : 0;
                return (
                  <tr key={n}>
                    <td className="num">{n + 1}</td>
                    <td className={r?.ok ? "mono ip" : "mono ip st-wait"}>
                      {r?.ok ? r.ip : "—"}
                      {dupCount > 1 && <span className="dup">×{dupCount} same IP</span>}
                    </td>
                    <td>
                      {r?.ok && r.score ? (
                        <span
                          className={scoreClass(r.score.fraudScore)}
                          title={`IPQS strictness level ${r.score.strictness}`}
                        >
                          {r.score.fraudScore}
                        </span>
                      ) : r?.ok && r.scoreError ? (
                        <span className="muted" title={r.scoreError}>
                          n/a
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
                    <td>
                      {r?.ok && r.score && (
                        <span className="flags">
                          {(
                            [
                              ["Proxy", r.score.proxy],
                              ["VPN", r.score.vpn],
                              ["Tor", r.score.tor],
                              ["Abuse", r.score.recentAbuse],
                              ["Bot", r.score.bot],
                            ] as const
                          )
                            .filter(([, on]) => on)
                            .map(([label]) => (
                              <span key={label} className="flag">
                                {label}
                              </span>
                            ))}
                          {!r.score.proxy && !r.score.vpn && !r.score.tor && !r.score.recentAbuse && !r.score.bot && (
                            <span className="flag clean">Clean</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="muted">
                      {r?.ok ? [r.city, r.region, r.countryCode].filter(Boolean).join(", ") : ""}
                    </td>
                    <td className="muted">{r?.ok ? r.isp ?? "" : ""}</td>
                    <td className="mono muted">{r?.ok ? `${r.ms} ms` : ""}</td>
                    <td className={r ? (r.ok ? "st-ok" : "st-bad") : "st-wait"}>
                      {r
                        ? r.ok
                          ? "Working"
                          : r.error
                        : it.state === "checking"
                        ? "Checking…"
                        : it.state === "stopped"
                        ? "Stopped"
                        : "Waiting"}
                    </td>
                    <td className="act">
                      <CopyButton text={it.line} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="footer">
        <div>
          Developed by <b>Francis Kamore Njoroge</b>
        </div>
        <div className="support">
          <span>Support development / pay for API keys via M-Pesa:</span>
          <span className="mono mpesa">0111446888</span>
          <CopyButton text="0111446888" label="Copy number" />
        </div>
      </footer>
    </div>
  );
}
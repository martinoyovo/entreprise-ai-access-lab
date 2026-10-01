"use client";

import { useState } from "react";

type Turn = { role: "user" | "assistant"; content: string };
type ToolCall = { name: string; input: unknown; ok: boolean; output: string };
type Entry = Turn & { toolCalls?: ToolCall[] };

// Minimal chat: the transcript lives in the browser and is sent with each message.
export default function Chat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    const next = [...entries, { role: "user" as const, content: draft.trim() }];
    setEntries(next);
    setDraft("");
    setBusy(true);
    setError(null);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      // 401 after SCIM deactivation or logout: the session is gone, so reload to the sign-in page.
      if (res.status === 401) window.location.reload();
      setError(body.error ?? `Request failed (${res.status})`);
      return;
    }
    setEntries([...next, { role: "assistant", content: body.reply || "(no reply)", toolCalls: body.toolCalls }]);
  }

  return (
    <section>
      {entries.map((m, i) => (
        <div key={i} style={{ margin: "12px 0" }}>
          <strong>{m.role === "user" ? "You" : "Claude"}:</strong>
          {m.toolCalls?.map((t, j) => (
            <details key={j} style={{ fontSize: 13, color: t.ok ? "#2d6a2d" : "#a33" }}>
              <summary>
                {t.ok ? "✓" : "✗"} {t.name}({JSON.stringify(t.input)})
              </summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{t.output}</pre>
            </details>
          ))}
          <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
        </div>
      ))}
      {error && <p style={{ color: "#a33" }}>{error}</p>}
      <form onSubmit={send} style={{ display: "flex", gap: 8 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask Claude…" style={{ flex: 1, padding: 8 }} disabled={busy} />
        <button type="submit" disabled={busy}>{busy ? "…" : "Send"}</button>
      </form>
    </section>
  );
}

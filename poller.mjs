// Draait op GitHub Actions (elke 15 min). Haalt recente mail op via IMAP
// en stuurt de berichten naar de base44-functie 'ingest-lead', die ze
// herkent, ontdubbelt en als Leads opslaat. Geen base44-login nodig —
// alleen een gedeeld geheim (INGEST_SECRET).

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const host = process.env.IMAP_HOST;
const port = parseInt(process.env.IMAP_PORT || "993", 10);
const user = process.env.IMAP_USER;
const pass = process.env.IMAP_PASSWORD;
const lookbackDays = parseInt(process.env.LEAD_LOOKBACK_DAYS || "1", 10);
const secret = process.env.INGEST_SECRET;
const url = process.env.INGEST_URL;

if (!host || !user || !pass || !secret || !url) {
  console.error("Ontbrekende env vars (IMAP_HOST/IMAP_USER/IMAP_PASSWORD/INGEST_SECRET/INGEST_URL).");
  process.exit(1);
}

const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
const messages = [];

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const uids = (await client.search({ since }, { uid: true })) || [];
  for (const uid of uids.slice(-80)) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
    if (!msg) continue;
    const parsed = await simpleParser(msg.source);
    messages.push({
      subject: parsed.subject || "",
      fromName: parsed.from?.value?.[0]?.name || "",
      fromAddr: parsed.from?.value?.[0]?.address || "",
      text: (parsed.text || "").trim(),
      messageId: parsed.messageId || `uid-${uid}`,
      date: (parsed.date || new Date()).toISOString(),
    });
  }
} finally {
  lock.release();
}
await client.logout();

console.log(`${messages.length} berichten opgehaald, versturen naar base44...`);
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret, messages }),
});
const out = await res.text();
console.log("Antwoord:", res.status, out);
if (!res.ok) process.exit(1);

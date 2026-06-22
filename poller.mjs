// Draait op GitHub Actions (elke 15 min). Haalt recente mail op via IMAP.
//  - Alle berichten -> base44-functie 'ingest-lead' (klantaanvragen).
//  - Factuur-mails (PDF uitgelezen) -> base44-functie 'ingest-invoice'.
// Geen base44-login nodig; alleen een gedeeld geheim (INGEST_SECRET).

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const host = process.env.IMAP_HOST;
const port = parseInt(process.env.IMAP_PORT || "993", 10);
const user = process.env.IMAP_USER;
const pass = process.env.IMAP_PASSWORD;
const lookbackDays = parseInt(process.env.LEAD_LOOKBACK_DAYS || "1", 10);
const secret = process.env.INGEST_SECRET;
const leadUrl = process.env.INGEST_URL;
const invoiceUrl = process.env.INGEST_INVOICE_URL;
const pocketUrl = process.env.POCKET_SYNC_URL;

if (!host || !user || !pass || !secret || !leadUrl) {
  console.error("Ontbrekende env vars (IMAP_HOST/IMAP_USER/IMAP_PASSWORD/INGEST_SECRET/INGEST_URL).");
  process.exit(1);
}

const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
const messages = [];
const invoices = [];

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const uids = (await client.search({ since }, { uid: true })) || [];
  for (const uid of uids.slice(-80)) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
    if (!msg) continue;
    const parsed = await simpleParser(msg.source);
    const subject = parsed.subject || "";
    const fromName = parsed.from?.value?.[0]?.name || "";
    const fromAddr = parsed.from?.value?.[0]?.address || "";
    const text = (parsed.text || "").trim();
    const html = (parsed.html || "").slice(0, 30000);
    const messageId = parsed.messageId || `uid-${uid}`;
    const date = (parsed.date || new Date()).toISOString();

    messages.push({ subject, fromName, fromAddr, text, html, messageId, date });

    // Factuur-kandidaat? PDF-bijlagen uitlezen.
    const pdfAtts = (parsed.attachments || []).filter(
      (a) => (a.contentType || "").includes("pdf") || (a.filename || "").toLowerCase().endsWith(".pdf")
    );
    const isInvoiceCandidate = pdfAtts.length > 0 || /factuur|rekening|pakbon|invoice|debnr|debiteur/.test(subject.toLowerCase());
    if (isInvoiceCandidate) {
      let pdfText = "";
      for (const att of pdfAtts) {
        if (att.content) {
          try { const r = await pdfParse(att.content); pdfText += "\n" + (r.text || ""); } catch { /* skip */ }
        }
      }
      invoices.push({ subject, fromName, fromAddr, date, messageId, pdfText: pdfText.slice(0, 8000), bodyText: text.slice(0, 2000) });
    }
  }
} finally {
  lock.release();
}
await client.logout();

async function post(url, payload, label) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(label, res.status, await res.text());
  return res.ok;
}

console.log(`${messages.length} berichten, ${invoices.length} factuur-kandidaten.`);
const okLeads = await post(leadUrl, { secret, messages }, "Leads:");
let okInv = true;
if (invoiceUrl && invoices.length) okInv = await post(invoiceUrl, { secret, invoices }, "Facturen:");
// Pocket-gesprekken ophalen (de base44-functie pakt zelf de Pocket-API met POCKET_API_KEY).
let okPocket = true;
if (pocketUrl) okPocket = await post(pocketUrl, { secret }, "Pocket:");
if (!okLeads || !okInv || !okPocket) process.exit(1);

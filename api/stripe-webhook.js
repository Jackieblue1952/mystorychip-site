import Stripe from "stripe";
import crypto from "crypto";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SITE_URL = "https://www.mystorychip.com";
const ALERT_EMAIL = "mystorychip@gmail.com";
const CLAIM_PRICE_CENTS = 4995;

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

// Next value from chip_code_seq, formatted MSC-##### (used for normal purchases only).
async function generateSequentialChipCode() {
  const result = await pool.query(`SELECT nextval('chip_code_seq') AS next`);
  return `MSC-${String(result.rows[0].next).padStart(5, "0")}`;
}

function newSetupToken() {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    hash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  };
}

function setupUrlFor(chipCode, token) {
  return `${SITE_URL}/client-setup.html?code=${encodeURIComponent(chipCode)}&token=${encodeURIComponent(token)}`;
}

async function sendEmail(to, subject, html) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({ from: "Storyteller <Storyteller@mystorychip.com>", to, subject, html })
    });
    if (!response.ok) {
      console.error(`Email to ${to} failed: ${response.status} ${await response.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Email to ${to} failed:`, err);
    return false;
  }
}

async function alertJack(subject, lines) {
  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const sent = await sendEmail(ALERT_EMAIL, `MSC ALERT: ${subject}`, html);
  if (!sent) console.error(`ALERT EMAIL FAILED - ${subject} - ${lines.join(" | ")}`);
}

function chipEmailHtml(name, chipCode, setupUrl, isClaim) {
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  const first = isClaim
    ? `This chip is now yours. Your chip code is <strong>${escapeHtml(chipCode)}</strong> &mdash; the same code that's on the chip you're holding.`
    : `Your chip code is <strong>${escapeHtml(chipCode)}</strong>.`;
  const second = isClaim
    ? "Tap the link below to set your own PIN, then replace the sample story and photos with your own."
    : "Tap the link below to set up your page &mdash; add your photos, story, and memories.";
  return `
    <p>${greeting} ${first}</p>
    <p>${second}</p>
    <p><a href="${setupUrl}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Set Up Your MyStoryChip</a></p>
    <p>Or copy and paste this link: ${setupUrl}</p>
    <p>This setup link works for 30 days.</p>
  `;
}

async function refundFailedClaim(stripe, session, claimCode, reason, email, name) {
  let refunded = false;
  try {
    await stripe.refunds.create(
      { payment_intent: session.payment_intent },
      { idempotencyKey: `claim-refund-${session.id}` }
    );
    refunded = true;
  } catch (err) {
    console.error(`Refund failed for session ${session.id}:`, err);
  }

  if (email) {
    await sendEmail(
      email,
      "About your MyStoryChip claim",
      `<p>${name ? `Hi ${escapeHtml(name)},` : "Hi,"}</p>
       <p>We're sorry &mdash; chip ${escapeHtml(claimCode || "")} can't be claimed because it was already claimed by someone else.</p>
       <p>${refunded
         ? "Your payment of $49.95 has been refunded. It can take 5&ndash;10 business days to show on your statement."
         : "Your payment of $49.95 will be refunded within one business day."}</p>
       <p>If you'd like your own MyStoryChip, visit <a href="${SITE_URL}">mystorychip.com</a>.</p>`
    );
  }

  await alertJack(refunded ? "Claim refunded" : "CLAIM REFUND FAILED - refund by hand in Stripe", [
    `Chip: ${claimCode || "(none)"}`,
    `Reason: ${reason}`,
    `Buyer: ${name || "(no name)"} ${email || "(no email)"}`,
    `Stripe session: ${session.id}`,
    refunded ? "The refund went through automatically." : "The automatic refund FAILED. Refund this payment by hand in the Stripe dashboard."
  ]);
  return refunded;
}

async function handleClaim(stripe, session, claimCode, email, name) {
  if (!/^MSC-\d+$/.test(claimCode) || session.amount_total !== CLAIM_PRICE_CENTS || session.currency !== "usd") {
    const refunded = await refundFailedClaim(stripe, session, claimCode, "claim details did not match ($49.95 USD, MSC code)", email, name);
    return { claimed: false, refunded };
  }

  const setup = newSetupToken();
  const result = await pool.query(
    `UPDATE chips SET
       customer_name = $2,
       customer_email = $3,
       phone = NULL,
       type = 'Claimed',
       status = 'claimed',
       claimable = false,
       claimed_at = NOW(),
       claim_session_id = $4,
       session_id = $4,
       pin = NULL,
       pin_hash = NULL,
       pin_failed_attempts = 0,
       pin_locked_until = NULL,
       pin_reset_token_hash = NULL,
       pin_reset_expires_at = NULL,
       setup_token_hash = $5,
       setup_token_expires_at = $6,
       auth_version = COALESCE(auth_version, 0) + 1,
       updated_at = NOW()
     WHERE chip_code = $1
       AND type = 'Demo / Promo Chip'
       AND claimable = true
       AND claimed_at IS NULL
     RETURNING chip_code`,
    [claimCode, name || null, email || null, session.id, setup.hash, setup.expiresAt]
  );

  if (!result.rows.length) {
    const refunded = await refundFailedClaim(stripe, session, claimCode, "chip was already claimed or is not for sale", email, name);
    return { claimed: false, refunded };
  }

  const sent = email
    ? await sendEmail(email, "Your MyStoryChip Is Ready!", chipEmailHtml(name, claimCode, setupUrlFor(claimCode, setup.token), true))
    : false;

  await alertJack(`Chip claimed - ${claimCode}`, [
    `Chip ${claimCode} was claimed and paid ($49.95).`,
    `Buyer: ${name || "(no name)"} ${email || "(no email)"}`,
    sent ? "The setup email was sent." : "THE SETUP EMAIL FAILED. Contact the buyer and resend a setup link."
  ]);
  return { claimed: true, emailSent: sent };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "Webhook endpoint ready" });
  }

  const rawBody = await getRawBody(req);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature check failed:", err.message);
    return res.status(400).json({ error: "Webhook signature check failed" });
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const sessionId = session.id;
  const email = String(session.customer_details?.email || "").trim().toLowerCase();
  const name = String(session.customer_details?.name || "").trim();
  const claimCode = String(session.metadata?.claim_code || "").trim();

  if (session.payment_status !== "paid") {
    console.log(`Session ${sessionId} completed with payment_status=${session.payment_status}; nothing done.`);
    return res.status(200).json({ received: true, paid: false });
  }

  try {
    const existing = await pool.query(
      `SELECT chip_code FROM chips WHERE session_id = $1 OR claim_session_id = $1 LIMIT 1`,
      [sessionId]
    );
    if (existing.rows.length) {
      console.log(`Duplicate webhook delivery for session ${sessionId}, skipping. Chip: ${existing.rows[0].chip_code}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    if (claimCode) {
      const outcome = await handleClaim(stripe, session, claimCode, email, name);
      return res.status(200).json({ received: true, ...outcome });
    }

    const chipCode = await generateSequentialChipCode();
    const setup = newSetupToken();
    await pool.query(
      `INSERT INTO chips (chip_code, customer_email, customer_name, session_id, setup_token_hash, setup_token_expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [chipCode, email || null, name || null, sessionId, setup.hash, setup.expiresAt]
    );

    const sent = email
      ? await sendEmail(email, "Your MyStoryChip Is Ready!", chipEmailHtml(name, chipCode, setupUrlFor(chipCode, setup.token), false))
      : false;
    if (!sent) {
      await alertJack(`Setup email failed - ${chipCode}`, [
        `New purchase ${chipCode} was saved, but the setup email did not send.`,
        `Buyer: ${name || "(no name)"} ${email || "(no email)"}`,
        "Contact the buyer and resend a setup link."
      ]);
    }

    return res.status(200).json({ received: true, chipCode });
  } catch (err) {
    if (err.code === "23505") {
      console.log(`Race-condition duplicate for session ${sessionId}, ignoring.`);
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error("Webhook handler error:", err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}

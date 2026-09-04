import Stripe from "stripe";
import crypto from "crypto";
import pkg from "pg";
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Pulls the next value from the chip_code_seq sequence (created in Neon)
// and formats it as MSC-##### (5 digits, zero-padded).
async function generateSequentialChipCode() {
  const result = await pool.query(`SELECT nextval('chip_code_seq') AS next`);
  const next = result.rows[0].next;
  const padded = String(next).padStart(5, "0");
  return `MSC-${padded}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "Webhook endpoint ready" });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers["stripe-signature"];
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const sessionId = session.id;
    const customerEmail = session.customer_details?.email;
    const customerName = session.customer_details?.name;

    try {
      const existing = await pool.query(
        `SELECT chip_code FROM chips WHERE session_id = $1`,
        [sessionId]
      );

      if (existing.rows.length > 0) {
        const chipCode = existing.rows[0].chip_code;
        console.log(`Duplicate webhook delivery for session ${sessionId}, skipping. Existing chip: ${chipCode}`);
        return res.status(200).json({ received: true, chipCode, duplicate: true });
      }

      const chipCode = await generateSequentialChipCode();
      const setupToken = crypto.randomBytes(32).toString("hex");
      const setupTokenHash = crypto
        .createHash("sha256")
        .update(setupToken)
        .digest("hex");
      const setupTokenExpiresAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );

       await pool.query(
        `INSERT INTO chips (
           chip_code,
           customer_email,
           customer_name,
           session_id,
           setup_token_hash,
           setup_token_expires_at,
           created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          chipCode,
          customerEmail,
          customerName,
          sessionId,
          setupTokenHash,
          setupTokenExpiresAt
        ]
      );

       const setupUrl =
        `https://www.mystorychip.com/client-setup.html?code=${encodeURIComponent(chipCode)}` +
        `&token=${encodeURIComponent(setupToken)}`;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: "Storyteller <Storyteller@mystorychip.com>",
          to: customerEmail,
          subject: "Your MyStoryChip Is Ready!",
          html: `
            <p>Hi ${customerName}, your chip code is <strong>${chipCode}</strong>.</p>
            <p>Tap the link below to set up your page — add your photos, story, and memories.</p>
            <p><a href="${setupUrl}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Set Up Your MyStoryChip</a></p>
            <p>Or copy and paste this link: ${setupUrl}</p>
          `
        })
      });

      return res.status(200).json({ received: true, chipCode });
    } catch (err) {
      if (err.code === "23505" && err.constraint && err.constraint.includes("session_id")) {
        console.log(`Race-condition duplicate for session ${sessionId}, ignoring.`);
        return res.status(200).json({ received: true, duplicate: true });
      }
      console.error("Webhook handler error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).json({ received: true });
}

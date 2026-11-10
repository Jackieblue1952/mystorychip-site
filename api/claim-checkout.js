import Stripe from "stripe";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SITE_URL = "https://www.mystorychip.com";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Please use the Make it yours button on the chip page." });
  }

  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!/^MSC-\d+$/.test(code)) {
    return res.status(400).json({ success: false, error: "That chip code doesn't look right." });
  }

  try {
    const result = await pool.query(
      `SELECT chip_code FROM chips
       WHERE chip_code = $1 AND type = 'Demo / Promo Chip' AND claimable = true AND claimed_at IS NULL
       LIMIT 1`,
      [code]
    );
    if (!result.rows.length) {
      return res.status(409).json({ success: false, error: "This chip isn't available to claim. It may already belong to someone." });
    }

    const stripe = new Stripe(String(process.env.STRIPE_SECRET_KEY || "").trim());
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 4995,
          product_data: {
            name: `MyStoryChip ${code}`,
            description: "Make this chip yours: your own PIN and your own 250 MB story page. One-time payment."
          }
        }
      }],
      metadata: { claim_code: code },
      payment_intent_data: { metadata: { claim_code: code } },
      success_url: `${SITE_URL}/claim-thanks.html?code=${encodeURIComponent(code)}`,
      cancel_url: `${SITE_URL}/chip.html?code=${encodeURIComponent(code)}`
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error("Claim checkout error:", err);
    return res.status(500).json({ success: false, error: "We couldn't open checkout right now. Please try again in a minute." });
  }
}

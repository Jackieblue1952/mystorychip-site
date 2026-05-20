import Stripe from "stripe";
import pkg from "pg";
const { Pool } = pkg;

export const config = {
  api: {
    bodyParser: false,
  },
};

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

function generateChipCode() {
  const number = Math.floor(1000 + Math.random() * 9000);
  return `MSC-${number}`;
}

async function sendWelcomeEmail(customerEmail, customerName, chipCode) {
  const setupLink = `https://mystorychip.com/success.html?code=${chipCode}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Storyteller <Storyteller@mystorychip.com>",
      to: customerEmail,
      subject: "Your MyStoryChip Is Ready — Let's Build Your Story!",
      html: `your existing email html here`
    }),
  });
  return response.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email;
    const customerName = session.customer_details?.name || "Storyteller";

    if (!customerEmail) {
      return res.status(200).json({ received: true, note: "No email found" });
    }

    const chipCode = generateChipCode();

    await pool.query(
      `INSERT INTO chips (code, type, status, customer_name, customer_email, notes) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [chipCode, "Paid Customer Chip", "Assigned", customerName, customerEmail, 
       `Auto-created from Stripe order ${session.id}`]
    );

    await pool.query(
      `INSERT INTO activity_log (message) VALUES ($1)`,
      [`New chip ${chipCode} created for ${customerEmail} via Stripe.`]
    );

    await sendWelcomeEmail(customerEmail, customerName, chipCode);
  }

  return res.status(200).json({ received: true });
}

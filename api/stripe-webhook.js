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
      html: `<p>Hi ${customerName}, your chip code is <strong>${chipCode}</strong>. <a href="${setupLink}">Set up your page here</a>.</p>`,
    }),
  });
  return response;
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
    const customerEmail = session.customer_details?.email;
    const customerName = session.customer_details?.name;
    const chipCode = generateChipCode();

    try {
      await pool.query(
        `INSERT INTO chips (chip_code, customer_email, customer_name, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [chipCode, customerEmail, customerName]
      );
      await sendWelcomeEmail(customerEmail, customerName, chipCode);
      return res.status(200).json({ received: true, chipCode });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).json({ received: true });
  }
}

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
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0; padding:0; background:#0f0a05; font-family: Georgia, serif;">
          <div style="max-width:600px; margin:0 auto; padding:40px 24px;">
            <div style="text-align:center; margin-bottom:32px;">
              <h1 style="color:#d4af37; font-size:2.5rem; margin:0;">MyStoryChip</h1>
              <p style="color:#c8a96e; letter-spacing:3px; text-transform:uppercase; font-size:0.8rem; margin:8px 0 0;">Your Chip. Your Story.</p>
            </div>
            <div style="background:linear-gradient(145deg, rgba(255,245,210,0.95), rgba(255,230,160,0.85)); border-radius:20px; padding:32px; border:1px solid rgba(212,175,55,0.3);">
              <h2 style="color:#5a3b10; margin:0 0 16px;">Welcome, ${customerName}! 🎉</h2>
              <p style="color:#3e2a12; line-height:1.7; margin:0 0 20px;">
                Your MyStoryChip is on its way! While you wait for it to arrive,
                you can start building your digital story page right now.
              </p>
              <div style="background:rgba(255,255,255,0.6); border-radius:14px; padding:20px; margin:20px 0; text-align:center;">
                <p style="color:#7a5416; font-size:0.85rem; margin:0 0 8px; text-transform:uppercase; letter-spacing:2px;">Your Chip Code</p>
                <p style="color:#3e2a12; font-size:2rem; font-weight:bold; margin:0; letter-spacing:4px;">${chipCode}</p>
              </div>
              <p style="color:#3e2a12; line-height:1.7; margin:0 0 24px;">
                Click the button below to set up your page. Add your story, photos,
                documents, and anything that matters — then control what others see
                when they tap your chip.
              </p>
              <div style="text-align:center;">
                <a href="${setupLink}"
                   style="display:inline-block; padding:16px 32px; background:linear-gradient(135deg, #fff7bf, #f0c756, #c28a1e); color:#1b1005; font-weight:bold; font-size:1.05rem; border-radius:999px; text-decoration:none; box-shadow:0 8px 20px rgba(54,30,6,0.3);">
                  Build My Story Page →
                </a>
              </div>
            </div>
            <div style="margin-top:24px; padding:20px; background:rgba(255,255,255,0.05); border-radius:14px; border:1px solid rgba(212,175,55,0.15);">
              <p style="color:#c8a96e; font-size:0.85rem; line-height:1.6; margin:0;">
                <strong style="color:#d4af37;">Questions?</strong> We're here to help.<br>
                Text or call: <a href="tel:931-387-6060" style="color:#d4af37;">931-387-6060</a><br>
                Email: <a href="mailto:MyStoryChip@gmail.com" style="color:#d4af37;">MyStoryChip@gmail.com</a>
              </p>
            </div>
            <p style="text-align:center; color:rgba(200,169,110,0.45); font-size:0.75rem; margin-top:24px;">
              © 2026 MyStoryChip.com · Founder &amp; Creator: Jack W. Kennedy
            </p>
          </div>
        </body>
        </html>
      `,
    }),
  });
  r

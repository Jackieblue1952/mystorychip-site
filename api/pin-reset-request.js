import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const publicResponse = {
  success: true,
  message:
    "If the chip code and email match our records, a PIN reset link will be sent."
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "").trim();
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase();

  if (!code || !email) {
    return res.status(200).json(publicResponse);
  }

  try {
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    const result = await pool.query(
      `
      UPDATE chips
      SET pin_reset_token_hash = $3,
          pin_reset_expires_at =
            NOW() + INTERVAL '15 minutes',
          pin_reset_requested_at = NOW()
      WHERE chip_code = $1
        AND LOWER(customer_email) = $2
        AND (
          pin_reset_requested_at IS NULL
          OR pin_reset_requested_at <
             NOW() - INTERVAL '10 minutes'
        )
      RETURNING customer_name
      `,
      [code, email, resetTokenHash]
    );

    if (result.rows.length && process.env.RESEND_API_KEY) {
      const siteUrl = String(
        process.env.MSC_SITE_URL ||
        "https://www.mystorychip.com"
      ).replace(/\/+$/, "");

      const resetUrl =
        `${siteUrl}/reset-pin.html?code=` +
        `${encodeURIComponent(code)}&token=` +
        `${encodeURIComponent(resetToken)}`;

      try {
        const emailResponse = await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization":
                `Bearer ${process.env.RESEND_API_KEY}`
            },
            body: JSON.stringify({
              from:
                "Storyteller <Storyteller@mystorychip.com>",
              to: email,
              subject: "Reset Your MyStoryChip PIN",
              html: `
                <p>Hello ${escapeHtml(
                  result.rows[0].customer_name ||
                  "Storyteller"
                )},</p>
                <p>A request was made to reset the PIN for ${escapeHtml(
                  code
                )}.</p>
                <p>This single-use link expires in 15 minutes.</p>
                <p><a href="${resetUrl}">Reset My PIN</a></p>
                <p>If you did not request this, you can safely ignore this email.</p>
              `
            })
          }
        );

        if (!emailResponse.ok) {
          console.error(
            "PIN reset email failed:",
            emailResponse.status,
            await emailResponse.text()
          );
        }
      } catch (emailError) {
        console.error(
          "PIN reset email error:",
          emailError.message
        );
      }
    }

    return res.status(200).json(publicResponse);
  } catch (err) {
    console.error("PIN reset request error:", err.message);

    return res.status(500).json({
      success: false,
      error: "PIN reset request could not be processed"
    });
  }
}

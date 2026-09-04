import crypto from "crypto";
import bcrypt from "bcryptjs";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function tokenMatches(providedToken, storedHash) {
  if (!providedToken || !storedHash) {
    return false;
  }

  const providedHash = crypto
    .createHash("sha256")
    .update(providedToken)
    .digest();

  const expectedHash = Buffer.from(storedHash, "hex");

  return (
    providedHash.length === expectedHash.length &&
    crypto.timingSafeEqual(providedHash, expectedHash)
  );
}
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
  const token = String(req.body?.token || "").trim();
  const pin = String(req.body?.pin || "").trim();
  const pinConfirm = String(
    req.body?.pinConfirm || ""
  ).trim();

  if (!code || !token) {
    return res.status(401).json({
      success: false,
      error: "This PIN reset link is invalid or expired."
    });
  }

  if (!/^\d{4}$/.test(pin) || pin !== pinConfirm) {
    return res.status(400).json({
      success: false,
      error: "Enter and confirm a matching 4-digit PIN."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT
        pin_reset_token_hash,
        pin_reset_expires_at,
        customer_email,
        customer_name
      FROM chips
      WHERE chip_code = $1
      LIMIT 1
      FOR UPDATE
      `,
      [code]
    );

    if (
      !result.rows.length ||
      !result.rows[0].pin_reset_expires_at ||
      new Date(
        result.rows[0].pin_reset_expires_at
      ).getTime() <= Date.now() ||
      !tokenMatches(
        token,
        result.rows[0].pin_reset_token_hash
      )
    ) {
      await client.query("ROLLBACK");

      return res.status(401).json({
        success: false,
        error: "This PIN reset link is invalid or expired."
      });
    }

    const pinHash = await bcrypt.hash(pin, 12);

    await client.query(
      `
      UPDATE chips
      SET pin_hash = $2,
          pin = NULL,
          pin_reset_token_hash = NULL,
          pin_reset_expires_at = NULL,
          pin_failed_attempts = 0,
          pin_locked_until = NULL,
          auth_version = auth_version + 1
      WHERE chip_code = $1
      `,
      [code, pinHash]
    );

    await client.query("COMMIT");

    if (
      result.rows[0].customer_email &&
      process.env.RESEND_API_KEY
    ) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization":
              `Bearer ${process.env.RESEND_API_KEY}`
          },
          body: JSON.stringify({
            from:
              "Storyteller <Storyteller@mystorychip.com>",
            to: result.rows[0].customer_email,
            subject: "Your MyStoryChip PIN Was Changed",
            html: `
              <p>Hello ${
             escapeHtml(
  result.rows[0].customer_name || "Storyteller"
)
              },</p>
              <p>The PIN for ${code} was successfully changed.</p>
              <p>If you did not make this change, contact MyStoryChip immediately.</p>
            `
          })
        });
      } catch (emailError) {
        console.error(
          "PIN confirmation email error:",
          emailError.message
        );
      }
    }

    return res.status(200).json({
      success: true,
      code,
      message: "Your PIN was changed successfully."
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PIN reset error:", err.message);

    return res.status(500).json({
      success: false,
      error: "PIN could not be reset"
    });
  } finally {
    client.release();
  }
}

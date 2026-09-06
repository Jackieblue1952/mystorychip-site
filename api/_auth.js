import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
export async function verifyEditSession(req, chipCode) {
  const secret = process.env.MSC_SESSION_SECRET;

  if (!secret || !chipCode) {
    return false;
  }

  const cookieHeader = String(req.headers.cookie || "");
  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith("msc_edit_session="));

  if (!sessionCookie) {
    return false;
  }

  const session = sessionCookie
    .slice("msc_edit_session=".length)
    .split(".");

  if (session.length !== 2) {
    return false;
  }

  const [payload, providedSignature] = session;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return false;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

      if (
      data.code !== chipCode ||
      Number(data.expiresAt) <= Date.now()
    ) {
      return false;
    }

    const result = await pool.query(
      `
      SELECT auth_version
      FROM chips
      WHERE chip_code = $1
      LIMIT 1
      `,
      [chipCode]
    );

    if (!result.rows.length) {
      return false;
    }

    return (
      Number(data.authVersion) ===
      Number(result.rows[0].auth_version)
    );
  } catch {
    return false;
  }
}

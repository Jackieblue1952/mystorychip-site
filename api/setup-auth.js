import crypto from "crypto";
import bcrypt from "bcryptjs";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function createEditSession(chipCode, authVersion) {
  const secret = process.env.MSC_SESSION_SECRET;

  if (!secret) {
    throw new Error("MSC_SESSION_SECRET is not configured");
  }

  const payload = Buffer.from(
    JSON.stringify({
          code: chipCode,
      authVersion: Number(authVersion),
      expiresAt: Date.now() + 12 * 60 * 60 * 1000
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const body = req.body || {};
  const code = String(body.code || "").trim();
  const setupToken = String(body.token || "").trim();
  const pin = String(body.pin || "").trim();

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Chip code is required"
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        chip_code,
        setup_token_hash,
        setup_token_expires_at,
               pin,
        pin_hash,
        pin_failed_attempts,
        pin_locked_until,
        auth_version
      FROM chips
      WHERE chip_code = $1
      LIMIT 1
      `,
      [code]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        error: "Authorization failed"
      });
    }

    const chip = result.rows[0];
    let authorized = false;

    if (
      setupToken &&
      chip.setup_token_expires_at &&
      new Date(chip.setup_token_expires_at).getTime() > Date.now()
    ) {
      authorized = tokenMatches(setupToken, chip.setup_token_hash);
    }
    if (!authorized && pin && chip.pin_locked_until) {
      const lockedUntil = new Date(chip.pin_locked_until).getTime();

      if (lockedUntil > Date.now()) {
        const minutesRemaining = Math.max(
          1,
          Math.ceil((lockedUntil - Date.now()) / 60000)
        );

        return res.status(429).json({
          success: false,
          error:
            `Too many incorrect PIN attempts. Try again in ${minutesRemaining} minute(s).`
        });
      }

      await pool.query(
        `
        UPDATE chips
        SET pin_failed_attempts = 0,
            pin_locked_until = NULL
        WHERE chip_code = $1
        `,
        [code]
      );

      chip.pin_failed_attempts = 0;
      chip.pin_locked_until = null;
    }

    if (!authorized && /^\d{4}$/.test(pin)) {
      if (chip.pin_hash) {
        authorized = await bcrypt.compare(pin, chip.pin_hash);
      } else if (chip.pin) {
        authorized = chip.pin === pin;

        if (authorized) {
          const pinHash = await bcrypt.hash(pin, 12);

          await pool.query(
            `
            UPDATE chips
            SET pin_hash = $2
            WHERE chip_code = $1
            `,
            [code, pinHash]
          );
        }
      }
    }

       if (!authorized) {
      if (pin) {
        const failedResult = await pool.query(
          `
          UPDATE chips
          SET pin_failed_attempts = pin_failed_attempts + 1,
              pin_locked_until =
                CASE
                  WHEN pin_failed_attempts + 1 >= 5
                  THEN NOW() + INTERVAL '15 minutes'
                  ELSE NULL
                END
          WHERE chip_code = $1
          RETURNING pin_locked_until
          `,
          [code]
        );

        if (failedResult.rows[0]?.pin_locked_until) {
          return res.status(429).json({
            success: false,
            error:
              "Too many incorrect PIN attempts. Try again in 15 minutes."
          });
        }
      }

      return res.status(401).json({
        success: false,
        error: "Authorization failed"
      });
    }
    if (pin) {
      await pool.query(
        `
        UPDATE chips
        SET pin_failed_attempts = 0,
            pin_locked_until = NULL
        WHERE chip_code = $1
        `,
        [code]
      );
    }

       const session = createEditSession(
      chip.chip_code,
      chip.auth_version
    );

    res.setHeader(
      "Set-Cookie",
      `msc_edit_session=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`
    );

    return res.status(200).json({
      success: true,
      code: chip.chip_code
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

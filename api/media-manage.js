import { del } from "@vercel/blob";
import pkg from "pg";
import { verifyEditSession } from "./_auth.js";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const body = req.body || {};
  const pathname = String(body.pathname || "").trim();
  const action = String(body.action || "").trim();

  if (!pathname || pathname.includes("..")) {
    return res.status(400).json({
      success: false,
      error: "Valid media pathname required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const mediaResult = await client.query(
      `
      SELECT
        chip_code,
        size_bytes,
        visibility
      FROM chip_media
      WHERE pathname = $1
        AND deleted_at IS NULL
      FOR UPDATE
      `,
      [pathname]
    );

    if (!mediaResult.rows.length) {
      throw new Error("Media not found");
    }

    const media = mediaResult.rows[0];

    if (!(await verifyEditSession(req, media.chip_code))) {
      throw new Error("Editing authorization required");
    }

    if (action === "visibility") {
      const visibility =
        body.visibility === "private"
          ? "private"
          : "public";

      await client.query(
        `
        UPDATE chip_media
        SET visibility = $2
        WHERE pathname = $1
        `,
        [pathname, visibility]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        success: true,
        pathname,
        visibility
      });
    }

    if (action === "delete") {
      await del(pathname, {
        storeId: process.env.BLOB_STORE_ID
      });

      await client.query(
        `
        UPDATE chip_media
        SET
          deleted_at = NOW(),
          mirror_status = 'deleted'
        WHERE pathname = $1
        `,
        [pathname]
      );

      await client.query(
        `
        UPDATE chips
        SET
          storage_used_bytes = GREATEST(
            0,
            storage_used_bytes - $2
          ),
          updated_at = NOW()
        WHERE chip_code = $1
        `,
        [media.chip_code, media.size_bytes]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        success: true,
        pathname,
        deleted: true
      });
    }

    throw new Error("Invalid media action");
  } catch (err) {
    await client.query("ROLLBACK");

    return res.status(400).json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
}

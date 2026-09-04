import { head } from "@vercel/blob";
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
  const code = String(body.code || "").trim();
  const pathname = String(body.pathname || "").trim();
  const mediaType = String(body.mediaType || "").trim();
  const filename =
    String(body.filename || "file").slice(0, 255);
  const visibility =
    body.visibility === "private"
      ? "private"
      : "public";

  if (!/^MSC-\d{4,5}$/.test(code)) {
    return res.status(400).json({
      success: false,
      error: "Invalid chip code"
    });
  }

  if (!["image", "document"].includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error: "Invalid media type"
    });
  }

  const folder =
    mediaType === "image" ? "images" : "documents";

  const requiredPrefix =
    `Storytellers/${code}/${folder}/`;

  if (
    !pathname.startsWith(requiredPrefix) ||
    pathname.includes("..")
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid media pathname"
    });
  }

  if (!(await verifyEditSession(req, code))) {
    return res.status(401).json({
      success: false,
      error: "Editing authorization required"
    });
  }

  const client = await pool.connect();

  try {
    const blobInfo = await head(pathname, {
      storeId: process.env.BLOB_STORE_ID
    });

    await client.query("BEGIN");

    const chipResult = await client.query(
      `
      SELECT storage_limit_bytes, storage_used_bytes
      FROM chips
      WHERE chip_code = $1
      FOR UPDATE
      `,
      [code]
    );

    if (!chipResult.rows.length) {
      throw new Error("Chip not found");
    }

    const existingResult = await client.query(
      `
      SELECT id
      FROM chip_media
      WHERE pathname = $1
      LIMIT 1
      `,
      [pathname]
    );

    if (existingResult.rows.length) {
      await client.query("COMMIT");

      return res.status(200).json({
        success: true,
        pathname,
        alreadyRegistered: true
      });
    }

    const limit = Number(
      chipResult.rows[0].storage_limit_bytes
    );
    const used = Number(
      chipResult.rows[0].storage_used_bytes
    );

    if (used + blobInfo.size > limit) {
      throw new Error("Storage limit exceeded");
    }

    await client.query(
      `
      INSERT INTO chip_media (
        chip_code,
        pathname,
        blob_url,
        filename,
        media_type,
        content_type,
        size_bytes,
        visibility,
        mirror_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      `,
      [
        code,
        blobInfo.pathname,
        blobInfo.url,
        filename,
        mediaType,
        blobInfo.contentType,
        blobInfo.size,
        visibility
      ]
    );

    await client.query(
      `
      UPDATE chips
      SET
        storage_used_bytes =
          storage_used_bytes + $2,
        updated_at = NOW()
      WHERE chip_code = $1
      `,
      [code, blobInfo.size]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      pathname,
      sizeBytes: blobInfo.size,
      contentType: blobInfo.contentType
    });
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

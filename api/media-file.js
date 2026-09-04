import { Readable } from "node:stream";
import { get } from "@vercel/blob";
import pkg from "pg";
import { verifyEditSession } from "./_auth.js";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const pathname = String(req.query.pathname || "").trim();

  if (!pathname || pathname.includes("..")) {
    return res.status(400).json({
      success: false,
      error: "Valid media pathname required"
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        chip_code,
        filename,
        visibility,
        content_type
      FROM chip_media
      WHERE pathname = $1
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [pathname]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        error: "Media not found"
      });
    }

    const media = result.rows[0];

    if (
      media.visibility === "private" &&
      !(await verifyEditSession(req, media.chip_code))
    ) {
      return res.status(401).json({
        success: false,
        error: "Authorization required"
      });
    }

    const blobResult = await get(pathname, {
      access: "private",
      storeId: process.env.BLOB_STORE_ID
    });

    if (!blobResult) {
      return res.status(404).json({
        success: false,
        error: "Stored file not found"
      });
    }

    res.setHeader(
      "Content-Type",
      blobResult.blob.contentType ||
        media.content_type ||
        "application/octet-stream"
    );

    if (blobResult.blob.size !== null) {
      res.setHeader(
        "Content-Length",
        String(blobResult.blob.size)
      );
    }

    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`
    );

    res.setHeader(
      "Cache-Control",
      media.visibility === "public"
        ? "public, max-age=3600"
        : "private, no-store"
    );

    Readable.fromWeb(blobResult.stream).pipe(res);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

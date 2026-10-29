import crypto from "crypto";
import { Readable } from "node:stream";
import { get } from "@vercel/blob";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// MSC VAULT DOOR — opens only for the Vostro vault program holding MSC_VAULT_KEY.
// It can list waiting files, hand over one waiting file, and record vault status.
// It cannot delete, change or create customer files.

function vaultKeyOk(req) {
  const expected = process.env.MSC_VAULT_KEY || "";
  const provided = String(req.headers["x-msc-vault-key"] || "");
  if (expected.length < 32) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!vaultKeyOk(req)) {
    await new Promise((r) => setTimeout(r, 500));
    return res.status(401).json({ success: false, error: "Vault authorization required" });
  }

  const action = String(req.query.action || "");

  try {
    if (req.method === "GET" && action === "pending") {
      const r = await pool.query(
        `SELECT id, chip_code, pathname, media_type, size_bytes
         FROM chip_media
         WHERE mirror_status = 'pending' AND deleted_at IS NULL
         ORDER BY id
         LIMIT 25`
      );
      return res.status(200).json({ success: true, files: r.rows });
    }

    if (req.method === "GET" && action === "erase") {
      const r = await pool.query(
        `SELECT id, chip_code, pathname
         FROM chip_media
         WHERE mirror_status = 'deleted' AND deleted_at IS NOT NULL
         ORDER BY id
         LIMIT 25`
      );
      return res.status(200).json({ success: true, files: r.rows });
    }

    if (req.method === "GET" && action === "file") {
      const id = Number(req.query.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: "Valid id required" });
      }
      const r = await pool.query(
        `SELECT pathname
         FROM chip_media
         WHERE id = $1 AND mirror_status = 'pending' AND deleted_at IS NULL
         LIMIT 1`,
        [id]
      );
      if (!r.rows.length) {
        return res.status(404).json({ success: false, error: "No waiting file with that id" });
      }
      const blobResult = await get(r.rows[0].pathname, {
        access: "private",
        storeId: process.env.BLOB_STORE_ID
      });
      if (!blobResult) {
        return res.status(404).json({ success: false, error: "Stored file not found" });
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (blobResult.blob.size !== null) {
        res.setHeader("Content-Length", String(blobResult.blob.size));
      }
      Readable.fromWeb(blobResult.stream).pipe(res);
      return;
    }

    if (req.method === "POST" && action === "mark") {
      const id = Number(req.body?.id);
      const status = String(req.body?.status || "");
      const from = { mirrored: "pending", vault_erased: "deleted" }[status];
      if (!Number.isInteger(id) || id <= 0 || !from) {
        return res.status(400).json({ success: false, error: "Valid id and status required" });
      }
      const r = await pool.query(
        `UPDATE chip_media
         SET mirror_status = $2
         WHERE id = $1 AND mirror_status = $3
         RETURNING id`,
        [id, status, from]
      );
      if (!r.rows.length) {
        return res.status(409).json({ success: false, error: "File is not in the expected state" });
      }
      return res.status(200).json({ success: true, id, status });
    }

    return res.status(400).json({ success: false, error: "Unknown vault action" });
  } catch (err) {
    console.error("Vault door error:", err.message);
    return res.status(500).json({ success: false, error: "Vault request failed" });
  }
}

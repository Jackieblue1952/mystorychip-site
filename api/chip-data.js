import pkg from "pg";
import bcrypt from "bcryptjs";
import { verifyEditSession } from "./_auth.js";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  const code = String(req.method === "GET" ? req.query.code || "" : req.body?.code || "").trim();

  if (!code) {
    return res.status(400).json({ success: false, error: "Chip code is required" });
  }

  try {
    if (req.method === "GET") {
      const result = await pool.query(
        `
        SELECT
          chip_code,
          customer_name,
          customer_email,
          phone,
          title,
          headline,
          story,
          chip_purpose,
          visibility,

          images,
          documents,
          storage_limit_bytes,
          storage_used_bytes,
          updated_at,
          status,
          created_at
        FROM chips
        WHERE chip_code = $1
        LIMIT 1
        `,
        [code]
      );

      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: "Chip not found" });
      }

      const row = result.rows[0];
      const hasEditAccess = await verifyEditSession(req, code);

      if (row.visibility === "private" && !hasEditAccess) {
        return res.status(401).json({
          success: false,
          requiresPin: true,
          error: "This Story Page is private"
        });
      }
      const mediaResult = await pool.query(
        `
        SELECT
          pathname,
          filename,
          media_type,
          content_type,
          size_bytes,
          visibility
        FROM chip_media
                WHERE chip_code = $1
          AND deleted_at IS NULL
          AND ($2::boolean OR visibility = 'public')
        ORDER BY created_at
        `,
                [code, hasEditAccess]
      );

      const storedImages = mediaResult.rows
        .filter((media) => media.media_type === "image")
        .map((media) => ({
          src:
            "/api/media-file?pathname=" +
            encodeURIComponent(media.pathname),
          pathname: media.pathname,
          filename: media.filename,
          contentType: media.content_type,
          sizeBytes: Number(media.size_bytes),
          storage: "blob",
          visibility: media.visibility
        }));

      const storedDocuments = mediaResult.rows
        .filter((media) => media.media_type === "document")
        .map((media) => ({
          src:
            "/api/media-file?pathname=" +
            encodeURIComponent(media.pathname),
          pathname: media.pathname,
          filename: media.filename,
          contentType: media.content_type,
          sizeBytes: Number(media.size_bytes),
          storage: "blob",
          visibility: media.visibility
        }));
      const legacyImages = (Array.isArray(row.images) ? row.images : [])
        .filter((image) =>
          hasEditAccess ||
          typeof image === "string" ||
          image?.visibility !== "private"
        );

      const legacyDocuments = (Array.isArray(row.documents) ? row.documents : [])
        .filter((document) =>
          hasEditAccess ||
          typeof document === "string" ||
          document?.visibility !== "private"
        );

      return res.status(200).json({
        success: true,
        chip: {
          code: row.chip_code,
          chip_code: row.chip_code,
                   fullName: hasEditAccess ? row.customer_name || "" : "",
          customer_name: hasEditAccess ? row.customer_name || "" : "",
          email: hasEditAccess ? row.customer_email || "" : "",
          customer_email: hasEditAccess ? row.customer_email || "" : "",
          phone: hasEditAccess ? row.phone || "" : "",
          title: row.title || "",
          headline: row.headline || "",
          desc: row.story || "",
          story: row.story || "",
          description: row.story || "",
          chipPurpose: row.chip_purpose || "",
          category: row.chip_purpose || "",
          visibility: row.visibility || "private",

                   images: [
           ...legacyImages,
            ...storedImages
          ],
          documents: [
          ...legacyDocuments,
            ...storedDocuments
          ],
          storageLimitBytes: Number(row.storage_limit_bytes),
          storageUsedBytes: Number(row.storage_used_bytes),
          updatedAt: row.updated_at,
          status: row.status || "",
          created_at: row.created_at,
        },
      });
    }
    if (req.method === "POST") {
      if (!(await verifyEditSession(req, code))) {
        return res.status(401).json({
          success: false,
          error: "Editing authorization required"
        });
      }

      const body = req.body || {};

      const images = Array.isArray(body.images) ? body.images : [];
      const documents = Array.isArray(body.documents) ? body.documents : [];
      const submittedPin = String(body.pin || "").trim();

      if (!/^\d{4}$/.test(submittedPin)) {
        return res.status(400).json({
          success: false,
          error: "A valid 4-digit PIN is required"
        });
      }

      const pinHash = await bcrypt.hash(submittedPin, 12);
      const result = await pool.query(
        `
        UPDATE chips
        SET
          customer_name = $2,
          customer_email = $3,
          phone = $4,
          title = $5,
          headline = $6,
          story = $7,
          chip_purpose = $8,
          visibility = $9,
          pin = NULL,
          pin_hash = $10,
          setup_token_hash = NULL,
          setup_token_expires_at = NULL,
          images = $11::jsonb,
          documents = $12::jsonb,
          updated_at = NOW(),
          status = 'setup_complete'
        WHERE chip_code = $1
        RETURNING chip_code
        `,
        [
          code,
          body.fullName || body.customer_name || null,
          body.email || body.customer_email || null,
          body.phone || null,
          body.title || null,
          body.headline || null,
          body.desc || body.story || body.description || null,
          body.chipPurpose || body.category || null,
          body.visibility || "private",
          pinHash,
          JSON.stringify(images),
          JSON.stringify(documents),
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: "Chip not found" });
      }

      return res.status(200).json({ success: true, code });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

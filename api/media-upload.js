import { del, head, issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import pkg from "pg";
import { verifyEditSession } from "./_auth.js";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
];

const DOCUMENT_TYPES = [
  "application/pdf",
  "text/plain",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];

function parseMetadata(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function validateMetadata(metadata, pathname) {
  const code = String(metadata.code || "").trim();
  const mediaType = String(metadata.mediaType || "").trim();

  if (!/^MSC-\d{4,5}$/.test(code)) {
    throw new Error("Invalid chip code");
  }

  if (!["image", "document"].includes(mediaType)) {
    throw new Error("Invalid media type");
  }

  const folder = mediaType === "image" ? "images" : "documents";
  const requiredPrefix = `Storytellers/${code}/${folder}/`;

  if (
    !pathname.startsWith(requiredPrefix) ||
    pathname.includes("..")
  ) {
    throw new Error("Invalid media pathname");
  }

  return {
    code,
    mediaType,
    filename: String(metadata.filename || "file").slice(0, 255),
    visibility:
      metadata.visibility === "private" ? "private" : "public"
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const response = await handleUploadPresigned({
      request: req,
      body: req.body,

      getSignedToken: async (
        pathname,
        clientPayload
      ) => {
        const metadata = validateMetadata(
          parseMetadata(clientPayload),
          pathname
        );

        if (!(await verifyEditSession(req, metadata.code))) {
          throw new Error("Editing authorization required");
        }

        const result = await pool.query(
          `
          SELECT storage_limit_bytes, storage_used_bytes
          FROM chips
          WHERE chip_code = $1
          LIMIT 1
          `,
          [metadata.code]
        );

        if (!result.rows.length) {
          throw new Error("Chip not found");
        }

        const limit = Number(result.rows[0].storage_limit_bytes);
        const used = Number(result.rows[0].storage_used_bytes);
        const remaining = limit - used;

        if (remaining <= 0) {
          throw new Error("Storage limit reached");
        }

        const allowedContentTypes =
          metadata.mediaType === "image"
            ? IMAGE_TYPES
            : DOCUMENT_TYPES;

        const token = await issueSignedToken({
          storeId: process.env.BLOB_STORE_ID,
          pathname,
          operations: ["put"],
          validUntil: Date.now() + 10 * 60 * 1000,
          allowedContentTypes,
          maximumSizeInBytes: remaining
        });

        return {
          token,
          urlOptions: {
            tokenPayload: JSON.stringify(metadata)
          }
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const metadata = validateMetadata(
          parseMetadata(tokenPayload),
          blob.pathname
        );

        const blobInfo = await head(blob.pathname, {
          storeId: process.env.BLOB_STORE_ID
        });

        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          const chipResult = await client.query(
            `
            SELECT storage_limit_bytes, storage_used_bytes
            FROM chips
            WHERE chip_code = $1
            FOR UPDATE
            `,
            [metadata.code]
          );

          if (!chipResult.rows.length) {
            throw new Error("Chip not found");
          }

          const limit = Number(
            chipResult.rows[0].storage_limit_bytes
          );
          const used = Number(
            chipResult.rows[0].storage_used_bytes
          );

          if (used + blobInfo.size > limit) {
            await del(blob.pathname, {
              storeId: process.env.BLOB_STORE_ID
            });

            throw new Error("Storage limit exceeded");
          }

          const insertResult = await client.query(
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
            ON CONFLICT (pathname) DO NOTHING
            RETURNING id
            `,
            [
              metadata.code,
              blobInfo.pathname,
              blobInfo.url,
              metadata.filename,
              metadata.mediaType,
              blobInfo.contentType,
              blobInfo.size,
              metadata.visibility
            ]
          );

          if (insertResult.rows.length) {
            await client.query(
              `
              UPDATE chips
              SET
                storage_used_bytes =
                  storage_used_bytes + $2,
                updated_at = NOW()
              WHERE chip_code = $1
              `,
              [metadata.code, blobInfo.size]
            );
          }

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
    });

    return res.status(200).json(response);
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
}

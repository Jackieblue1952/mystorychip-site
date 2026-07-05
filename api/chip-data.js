import pkg from "pg";
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
          pin,
          images,
          documents,
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

      return res.status(200).json({
        success: true,
        chip: {
          code: row.chip_code,
          chip_code: row.chip_code,
          fullName: row.customer_name || "",
          customer_name: row.customer_name || "",
          email: row.customer_email || "",
          customer_email: row.customer_email || "",
          phone: row.phone || "",
          title: row.title || "",
          headline: row.headline || "",
          desc: row.story || "",
          story: row.story || "",
          description: row.story || "",
          chipPurpose: row.chip_purpose || "",
          category: row.chip_purpose || "",
          visibility: row.visibility || "public",
          pin: row.pin || "",
          images: row.images || [],
          documents: row.documents || [],
          updatedAt: row.updated_at,
          status: row.status || "",
          created_at: row.created_at,
        },
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const images = Array.isArray(body.images) ? body.images : [];
      const documents = Array.isArray(body.documents) ? body.documents : [];

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
          pin = $10,
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
          body.visibility || "public",
          body.pin || null,
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

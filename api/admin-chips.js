import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    if (req.method === "POST") {
      const { chip_code, customer_name, customer_email } = req.body || {};

      if (!chip_code || String(chip_code).trim() === "") {
        return res.status(400).json({
          success: false,
          error: "chip_code is required",
        });
      }

      const cleanChipCode = String(chip_code).trim();

      const existing = await pool.query(
        "SELECT id FROM chips WHERE chip_code = $1 LIMIT 1",
        [cleanChipCode]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error: "Chip code already exists",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO chips (chip_code, customer_email, customer_name, type, created_at)
        VALUES ($1, $2, $3, 'Demo / Promo Chip', NOW())
        RETURNING
          id,
          chip_code,
          customer_name,
          customer_email,
          type,
          created_at
        `,
        [
          cleanChipCode,
          customer_email ? String(customer_email).trim() : null,
          customer_name ? String(customer_name).trim() : null,
        ]
      );

      return res.status(201).json({
        success: true,
        chip: result.rows[0],
      });
    }

    const result = await pool.query(`
      SELECT
        id,
        chip_code,
        customer_name,
        customer_email,
        type,
        created_at
      FROM chips
      ORDER BY created_at DESC
    `);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      chips: result.rows,
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Chip code already exists",
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

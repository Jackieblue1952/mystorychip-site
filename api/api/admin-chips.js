import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {

    const result = await pool.query(`
      SELECT
        id,
        chip_code,
        customer_name,
        customer_email,
        created_at
      FROM chips
      ORDER BY created_at DESC
    `);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      chips: result.rows
    });

  } catch (err) {

    return res.status(500).json({
      success: false,
      error: err.message
    });

  }

}

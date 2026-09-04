import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE chips
        ADD COLUMN IF NOT EXISTS setup_token_hash TEXT,
        ADD COLUMN IF NOT EXISTS setup_token_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS pin_hash TEXT,
        ADD COLUMN IF NOT EXISTS storage_limit_bytes BIGINT NOT NULL DEFAULT 262144000,
        ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chip_media (
        id BIGSERIAL PRIMARY KEY,
        chip_code TEXT NOT NULL REFERENCES chips(chip_code) ON DELETE CASCADE,
        pathname TEXT NOT NULL UNIQUE,
        blob_url TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        mirror_status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        mirrored_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ
      );
    `);
    await client.query(`
      ALTER TABLE chip_media
      ALTER COLUMN visibility SET DEFAULT 'private';
    `);


    await client.query(`
      CREATE INDEX IF NOT EXISTS chip_media_chip_code_idx
      ON chip_media (chip_code);
    `);

    await client.query("COMMIT");
    console.log("Media storage migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration error:", err.message);
  process.exit(1);
})

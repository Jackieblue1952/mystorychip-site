import { isAdmin } from './_admin-session.js';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}});
let ready;
async function schema() {
  if (!ready) ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS msc_nfc_tags (
      tag_id TEXT PRIMARY KEY, chip_code TEXT NOT NULL, link TEXT NOT NULL,
      locked BOOLEAN NOT NULL DEFAULT FALSE, operation TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS msc_nfc_tags_code_idx ON msc_nfc_tags(chip_code)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS msc_nfc_events (
      event_id TEXT PRIMARY KEY, tag_id TEXT NOT NULL, chip_code TEXT NOT NULL,
      link TEXT NOT NULL, locked BOOLEAN NOT NULL, operation TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })().catch(e => {ready=null;throw e;});
  return ready;
}
function authorized(req) {
  const token=process.env.MSC_NFC_WRITER_TOKEN;
  if (!token || token.length<32) return false;
  const got=Buffer.from(req.headers.authorization || '');
  const expected=Buffer.from('Bearer '+token);
  return got.length===expected.length && crypto.timingSafeEqual(got,expected);
}
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (!(authorized(req) || (req.method==='GET' && isAdmin(req)))) return res.status(401).json({ok:false,error:'Unauthorized'});
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ok:false,error:'Method not allowed'});
  let c;
  try {
    await schema();
    if (req.method==='GET') {
      const code=req.query?.code || '';
      if (code && !/^MSC-[0-9]{4,6}$/.test(code)) return res.status(400).json({ok:false,error:'Invalid code'});
      const page=Number(req.query?.page || 0);
      if (!Number.isSafeInteger(page) || page<0 || page>100000) return res.status(400).json({ok:false,error:'Invalid page'});
      const result=await pool.query(`SELECT tag_id,chip_code,link,locked,operation,verified_at,received_at
        FROM msc_nfc_tags WHERE ($1='' OR chip_code=$1) ORDER BY verified_at DESC,tag_id LIMIT 101 OFFSET $2`,[code,page*100]);
      return res.status(200).json({ok:true,records:result.rows.slice(0,100),has_more:result.rows.length>100,page});
    }
    const d=req.body || {};
    if (!/^[a-f0-9]{64}$/.test(d.event_id || '') || !/^04[A-F0-9]{12}$/.test(d.tag_id || '') ||
        !/^MSC-[0-9]{4,6}$/.test(d.code || '') || d.link!=='https://mystorychip.com/chip.html?code='+d.code ||
        typeof d.locked!=='boolean' || !['standard_write','matching_chip','verify','permanent_lock','verify_lock'].includes(d.operation) ||
        typeof d.time!=='string' || !Number.isFinite(Date.parse(d.time))) {
      return res.status(400).json({ok:false,error:'Invalid NFC record'});
    }
    c=await pool.connect();await c.query('BEGIN');
    // Serializes updates for this physical tag, including its first insertion.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[d.tag_id]);
    const chip=await c.query('SELECT chip_code FROM chips WHERE chip_code=$1 LIMIT 1',[d.code]);
    if (!chip.rows.length) {await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'Story Page code not found'});}
    const existing=await c.query('SELECT * FROM msc_nfc_tags WHERE tag_id=$1 FOR UPDATE',[d.tag_id]);
    if (existing.rows[0]?.locked && existing.rows[0].chip_code!==d.code) {
      await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'Locked tag is assigned to another code'});
    }
    const event=await c.query(`INSERT INTO msc_nfc_events(event_id,tag_id,chip_code,link,locked,operation,verified_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [d.event_id,d.tag_id,d.code,d.link,d.locked,d.operation,d.time]);
    if (event.rows.length) await c.query(`INSERT INTO msc_nfc_tags(tag_id,chip_code,link,locked,operation,verified_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tag_id) DO UPDATE SET chip_code=EXCLUDED.chip_code,
      link=EXCLUDED.link, locked=msc_nfc_tags.locked OR EXCLUDED.locked,operation=EXCLUDED.operation,
      verified_at=EXCLUDED.verified_at,received_at=NOW()
      WHERE EXCLUDED.verified_at >= msc_nfc_tags.verified_at`,
      [d.tag_id,d.code,d.link,d.locked,d.operation,d.time]);
    await c.query('COMMIT');return res.status(200).json({ok:true,event_id:d.event_id});
  } catch(e) {
    if(c) {try {await c.query('ROLLBACK');} catch {}}
    console.error('NFC record error',e.code || 'unknown');
    return res.status(500).json({ok:false,error:'NFC database operation failed'});
  } finally {if(c)c.release();}
}

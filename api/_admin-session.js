import crypto from 'crypto';
const ttl = 8 * 60 * 60 * 1000;
function sign(payload) {
  const secret = process.env.ADMIN_LOGIN_HASH;
  if (!secret) throw new Error('Admin login configuration missing');
  return crypto.createHmac('sha256', secret).update('msc-admin-v1:' + payload).digest('base64url');
}
export function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({purpose:'msc-admin', expiresAt:Date.now()+ttl, nonce:crypto.randomBytes(24).toString('hex')})).toString('base64url');
  return payload + '.' + sign(payload);
}
function valid(token) {
  try {
    if (typeof token !== 'string' || token.length > 2048) return false;
    const parts=token.split('.');if(parts.length!==2)return false;
    const [payload,sig]=parts;
    const a=Buffer.from(sig), b=Buffer.from(sign(payload));
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return false;
    const d=JSON.parse(Buffer.from(payload,'base64url').toString());
    return d.purpose==='msc-admin' && Number.isFinite(d.expiresAt) && d.expiresAt>Date.now() && d.expiresAt<=Date.now()+ttl;
  } catch { return false; }
}
export function isAdmin(req) {
  const bearer=String(req.headers.authorization || '').replace(/^Bearer /,'');
  if(valid(bearer))return true;
  return false;
}

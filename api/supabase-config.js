export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const cookie = req.headers.cookie || "";
  const hasToken = authHeader.startsWith("Bearer ") || cookie.includes("msc_admin=");

  if (!hasToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}

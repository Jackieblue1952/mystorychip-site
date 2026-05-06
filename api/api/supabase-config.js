export default function handler(req, res) {
  // Only allow GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify the request has a valid admin session cookie
  const cookie = req.headers.cookie || "";
  const hasAdminCookie = cookie.includes("msc_admin=");

  if (!hasAdminCookie) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Serve the Supabase config safely from environment variables
  return res.status(200).json({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}

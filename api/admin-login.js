import bcrypt from "bcryptjs";
import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;

  if (!password || typeof password !== "string") {
    return res.status(400).json({ success: false, error: "Invalid request" });
  }

  const hash = process.env.ADMIN_PASSWORD_HASH;

  if (!hash) {
    return res.status(500).json({ success: false, error: "Server configuration error" });
  }

  try {
    const match = await bcrypt.compare(password, hash);

    if (match) {
      const token = crypto.randomBytes(32).toString("hex");
      res.setHeader("Set-Cookie", [
        `msc_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
      ]);
      return res.status(200).json({ success: true, token });
    } else {
      await new Promise(r => setTimeout(r, 1000));
      return res.status(401).json({ success: false, error: "Invalid password" });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
}

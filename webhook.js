import express from "express";
import fs from "fs";

const app = express();
app.use(express.json());

const PRIORITY_FILE = "/root/meridian/active-priority-mint.json";

app.post("/signal", (req, res) => {
  try {
    const { mint, wallet, amount } = req.body;

    if (!mint) {
      return res.status(400).json({ error: "Missing mint" });
    }

    const data = {
      mint,
      wallet: wallet || "unknown",
      amount: amount || 0,
      detectedAt: Date.now(),
      used: false
    };

    fs.writeFileSync(PRIORITY_FILE, JSON.stringify(data, null, 2));

    console.log(`[WEBHOOK] New signal received: ${mint}`);

    res.json({ success: true });
  } catch (e) {
    console.error("[WEBHOOK] Error:", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(3001, () => {
  console.log("Webhook listening on port 3001");
});

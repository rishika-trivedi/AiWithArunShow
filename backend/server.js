import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("../public"));



app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = req.body.prompt;

    const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    }),
  }
);


    const data = await response.json();

    if (!response.ok) {
      console.log("Gemini error:", JSON.stringify(data, null, 2));
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: String(err) } });
  }
});



app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import xml2js from "xml2js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const ALLOWLIST = [
  "ai with arun",
  "aiwitharunshow",
  "aiwas",
  "arun",
  "the show",
  "episode",
  "youtube",
  "podcast",
  "channel",
  "guest",
  "interview",
  "newsletter",
  "website",
  "site",
  "contact",
  "services",
  "consulting",
  "speaking",
  "ai",
  "machine learning",
  "generative ai",
  "llm",
  "chatbot",
  "prompt",
  "hi",
  "hello",
  "how are you",
  "what is the ai with arun show",
];

const BLOCKLIST = [
  "homework",
  "geometry",
  "algebra",
  "physics",
  "chemistry",
  "biology",
  "history",
  "english essay",
  "relationship",
  "dating",
  "medical",
  "diagnosis",
  "legal advice",
  "song lyrics",
];

function isOnTopic(prompt) {
  const text = (prompt || "").toLowerCase().trim();
  if (!text) return false;
  if (BLOCKLIST.some((w) => text.includes(w))) return false;
  if (ALLOWLIST.some((w) => text.includes(w))) return true;
  return false;
}

const OFF_TOPIC_MESSAGE =
  "I can only answer questions about the AI With Arun Show (episodes, topics, guests, Arun’s AI work, or this website). What would you like to know about the show?";

const SYSTEM_INSTRUCTION = `
You are the assistant for the "AI With Arun Show" website.
You must ONLY answer questions related to:
- AI With Arun Show (episodes, topics, guests, formats)
- Arun's AI work as presented on the site
- The website itself (navigation, services, contact)

If the user asks anything unrelated, do not answer it.
Instead, politely say you can only help with AI With Arun Show questions and ask them to rephrase.
Keep responses friendly and concise.
`.trim();

// CORS (now supports GET too)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Gemini route
app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = req.body.prompt;

    if (!isOnTopic(userPrompt)) {
      return res.json({ guarded: true, message: OFF_TOPIC_MESSAGE });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `SYSTEM:\n${SYSTEM_INSTRUCTION}\n\nUSER:\n${userPrompt}` }],
            },
          ],
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

// YouTube RSS route
app.get("/api/youtube/latest", async (req, res) => {
  try {
    const channelId = "UCnOpIzLQgKq0yQGThlNCsqA";
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

    const r = await fetch(rssUrl);
    const xml = await r.text();

    const parsed = await xml2js.parseStringPromise(xml);
    const entries = parsed.feed.entry || [];

    const videos = entries.slice(0, 6).map((e) => ({
      title: e.title?.[0] || "",
      videoId: e["yt:videoId"]?.[0] || "",
      link: e.link?.[0]?.$?.href || "",
      published: e.published?.[0] || "",
      thumbnail: e["media:group"]?.[0]?.["media:thumbnail"]?.[0]?.$?.url || "",
    }));

    res.json({ videos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch YouTube feed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

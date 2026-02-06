import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import xml2js from "xml2js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// MIDDLEWARE
// =====================
app.use(express.json());
app.use(express.static("public"));

// CORS (frontend + backend safe)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// =====================
// CONFIG
// =====================
const CHANNEL_ID = "UCnOpIzLQgKq0yQGThlNCsqA";

const ALLOWLIST = [
  "ai with arun",
  "aiwitharunshow",
  "aiwas",
  "arun",
  "episode",
  "latest",
  "youtube",
  "podcast",
  "channel",
  "guest",
  "interview",
  "newsletter",
  "website",
  "services",
  "consulting",
  "ai",
  "machine learning",
  "generative ai",
  "chatbot",
  "hi",
  "hello",
  "what is the ai with arun show",
];

const BLOCKLIST = [
  "homework",
  "algebra",
  "geometry",
  "physics",
  "chemistry",
  "biology",
  "history",
  "dating",
  "medical",
  "diagnosis",
  "legal advice",
  "song lyrics",
];

// =====================
// HELPERS
// =====================
function isOnTopic(prompt) {
  const text = (prompt || "").toLowerCase();
  if (!text) return false;
  if (BLOCKLIST.some((w) => text.includes(w))) return false;
  if (ALLOWLIST.some((w) => text.includes(w))) return true;
  return false;
}

function isLatestEpisodeQuestion(prompt) {
  const t = (prompt || "").toLowerCase();
  return (
    t.includes("latest episode") ||
    t.includes("newest episode") ||
    (t.includes("most recent") && t.includes("episode")) ||
    t.includes("latest video") ||
    t.includes("newest video")
  );
}

async function getLatestYouTubeVideo() {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const r = await fetch(rssUrl);
  const xml = await r.text();

  const parsed = await xml2js.parseStringPromise(xml);
  const entry = parsed.feed.entry?.[0];
  if (!entry) return null;

  return {
    title: entry.title?.[0] || "",
    published: entry.published?.[0] || "",
    link: entry.link?.[0]?.$?.href || "",
  };
}

const OFF_TOPIC_MESSAGE =
  "I can only answer questions about the AI With Arun Show (episodes, topics, guests, Arun’s AI work, or this website). What would you like to know about the show?";

const SYSTEM_INSTRUCTION = `
You are the assistant for the AI With Arun Show website.
You must ONLY answer questions related to:
- AI With Arun Show episodes and topics
- Guests and interviews
- Arun’s AI work
- The website itself

If the user asks anything unrelated, politely refuse and redirect.
Keep responses friendly and concise.
`.trim();

// =====================
// ROUTES
// =====================

// GEMINI CHATBOT
app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = req.body.prompt;

    // 🔥 Special case: latest episode
    if (isLatestEpisodeQuestion(userPrompt)) {
      const latest = await getLatestYouTubeVideo();

      if (!latest) {
        return res.json({
          guarded: true,
          message: "I couldn’t find the latest episode right now. Try again shortly.",
        });
      }

      return res.json({
        guarded: true,
        message:
          `🎙️ Latest AI With Arun Show episode:\n\n` +
          `• Title: ${latest.title}\n` +
          `• Published: ${latest.published}\n` +
          `• Watch here: ${latest.link}`,
      });
    }

    // Guardrails
    if (!isOnTopic(userPrompt)) {
      return res.json({ guarded: true, message: OFF_TOPIC_MESSAGE });
    }

    // Gemini API call
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
      console.error("Gemini error:", data);
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: String(err) } });
  }
});

// YOUTUBE FEED (for frontend use)
app.get("/api/youtube/latest", async (req, res) => {
  try {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
    const r = await fetch(rssUrl);
    const xml = await r.text();

    const parsed = await xml2js.parseStringPromise(xml);
    const entries = parsed.feed.entry || [];

    const videos = entries.slice(0, 6).map((e) => ({
      title: e.title?.[0] || "",
      published: e.published?.[0] || "",
      link: e.link?.[0]?.$?.href || "",
      thumbnail:
        e["media:group"]?.[0]?.["media:thumbnail"]?.[0]?.$?.url || "",
    }));

    res.json({ videos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch YouTube feed" });
  }
});

// =====================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

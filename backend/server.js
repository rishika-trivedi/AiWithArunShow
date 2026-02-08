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

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// =====================
// CONFIG (✅ FIXED TO MATCH RENDER)
// =====================
const CHANNEL_ID = process.env.YT_CHANNEL_ID; // ✅ was hard-coded before
const YT_KEY = process.env.YT_API_KEY;

let lastEpisodeContext = null;
// { title, published, link, description, updatedAt }

const OFF_TOPIC_MESSAGE =
  "I can only answer questions about the AI With Arun Show (episodes, topics, guests, Arun’s AI work, or this website). What would you like to know about the show?";

const SYSTEM_INSTRUCTION = `
You are the assistant for the AI With Arun Show website.
You must ONLY answer questions related to:
- AI With Arun Show episodes and topics
- Guests and interviews
- Arun’s AI work
- The website itself
Keep responses concise and accurate.
`.trim();

// =====================
// HELPERS
// =====================
function wrapTextAsGemini(text) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
  };
}

function isLatestEpisodeQuestion(prompt = "") {
  const t = prompt.toLowerCase();
  return (
    (t.includes("latest") ||
      t.includes("newest") ||
      t.includes("most recent") ||
      t.includes("last")) &&
    (t.includes("episode") ||
      t.includes("episde") ||
      t.includes("video") ||
      t.includes("show") ||
      t.includes("podcast"))
  );
}

function isEpisodeAboutQuestion(prompt = "") {
  const t = prompt.toLowerCase();
  return (
    t.includes("what was this episode about") ||
    t.includes("what is this episode about") ||
    t.includes("what was it about") ||
    t.includes("what is it about") ||
    t.includes("tell me about this episode") ||
    t.includes("summary") ||
    t.includes("summarize") ||
    t.includes("recap")
  );
}

// =====================
// YOUTUBE DATA (REAL DESCRIPTION)
// =====================
async function getLatestEpisodeFromYouTube() {
  if (!YT_KEY || !CHANNEL_ID) return null;

  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&channelId=${CHANNEL_ID}&order=date&maxResults=1&type=video&key=${YT_KEY}`;

  const r = await fetch(searchUrl);
  const data = await r.json();

  if (!r.ok || !data.items?.length) return null;

  const item = data.items[0];
  const videoId = item.id.videoId;

  return {
    title: item.snippet.title,
    published: item.snippet.publishedAt,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    description: item.snippet.description || "",
  };
}

// =====================
// ROUTES
// =====================
app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = req.body.prompt || "";

    // 1️⃣ Latest episode (truth source)
    if (isLatestEpisodeQuestion(userPrompt)) {
      const latest = await getLatestEpisodeFromYouTube();

      if (!latest) {
        return res.json(
          wrapTextAsGemini("I couldn’t fetch the latest episode right now.")
        );
      }

      lastEpisodeContext = { ...latest, updatedAt: Date.now() };

      return res.json(
        wrapTextAsGemini(
          `🎙️ Latest AI With Arun Show episode:\n\n` +
            `• Title: ${latest.title}\n` +
            `• Published: ${latest.published}\n` +
            `• Watch: ${latest.link}\n\n` +
            `Ask: “What was this episode about?”`
        )
      );
    }

    // 2️⃣ Episode summary (grounded, no hallucinations)
    if (isEpisodeAboutQuestion(userPrompt)) {
      if (!lastEpisodeContext) {
        return res.json(
          wrapTextAsGemini('Ask “What is the latest episode?” first.')
        );
      }

      const { title, published, link, description } = lastEpisodeContext;

      if (!description || description.length < 40) {
        return res.json(
          wrapTextAsGemini(
            "I don’t have enough description text to summarize accurately."
          )
        );
      }

      const summaryPrompt = `
Summarize the episode using ONLY the description below.
Do NOT add facts not present.
If something is unknown, say “Not specified in the description.”

Title: ${title}
Published: ${published}
Link: ${link}

Description:
${description}

Return:
- 3–5 sentence summary
- 3 bullet key takeaways
`.trim();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
          }),
        }
      );

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      return res.json(data);
    }

    // 3️⃣ Normal chatbot
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
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: String(err) } });
  }
});

app.get("/api/debug/youtube", async (req, res) => {
  try {
    const channelId = process.env.YT_CHANNEL_ID;
    const apiKey = process.env.YT_API_KEY;

    // show whether env vars exist (safe: only shows first 4 chars of key)
    const envStatus = {
      YT_CHANNEL_ID_set: !!channelId,
      YT_CHANNEL_ID_value: channelId || null,
      YT_API_KEY_set: !!apiKey,
      YT_API_KEY_preview: apiKey ? apiKey.slice(0, 4) + "..." : null,
    };

    if (!channelId || !apiKey) {
      return res.status(400).json({
        ok: false,
        step: "env",
        envStatus,
        error: "Missing YT_CHANNEL_ID or YT_API_KEY on Render",
      });
    }

    const url =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}` +
      `&order=date&maxResults=1&type=video&key=${apiKey}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        step: "youtube_api",
        envStatus,
        youtubeStatus: r.status,
        youtubeError: data?.error || data,
      });
    }

    if (!data.items?.length) {
      return res.json({
        ok: false,
        step: "no_items",
        envStatus,
        note: "YouTube API returned 0 videos for this channelId",
        raw: data,
      });
    }

    const item = data.items[0];
    return res.json({
      ok: true,
      envStatus,
      latest: {
        title: item.snippet?.title,
        publishedAt: item.snippet?.publishedAt,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, step: "exception", error: String(e) });
  }
});


// =====================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

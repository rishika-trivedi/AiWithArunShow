import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

//ENV VARIABLES 
const YT_KEY = process.env.YT_API_KEY;
const CHANNEL_ID = process.env.YT_CHANNEL_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

let lastEpisodeContext = null; 

//Helpers 
function wrapTextAsGemini(text) {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
      },
    ],
  };
}

function isLatestEpisodeQuestion(prompt = "") {
  const t = prompt.toLowerCase();
  const wantsLatest =
    t.includes("latest") ||
    t.includes("newest") ||
    t.includes("most recent") ||
    t.includes("recent episode") ||
    t.includes("latest episode") ||
    t.includes("latest video") ||
    t.includes("new upload");

  const episodeWord =
    t.includes("episode") || t.includes("video") || t.includes("upload") || t.includes("show");

  return wantsLatest && episodeWord;
}

function isEpisodeAboutQuestion(prompt = "") {
  const t = prompt.toLowerCase();
  return (
    t.includes("what was this episode about") ||
    t.includes("what is this episode about") ||
    t.includes("what was it about") ||
    t.includes("what is it about") ||
    t.includes("tell me about this episode") ||
    t.includes("tell me about it") ||
    t.includes("summarize") ||
    t.includes("summary") ||
    t.includes("recap") ||
    t.includes("what is this about")
  );
}

// Fetch latest video + FULL description 
async function getLatestEpisodeFromYouTube() {
  if (!YT_KEY || !CHANNEL_ID) return null;

  // Find latest videoId
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&channelId=${CHANNEL_ID}&order=date&maxResults=1&type=video&key=${YT_KEY}`;

  const r1 = await fetch(searchUrl);
  const data1 = await r1.json();
  if (!r1.ok || !data1.items?.length) return null;

  const videoId = data1.items[0]?.id?.videoId;
  if (!videoId) return null;

  //Get full snippet (description, title, publishedAt) from videos endpoint
  const videoUrl =
    `https://www.googleapis.com/youtube/v3/videos?` +
    `part=snippet&id=${videoId}&key=${YT_KEY}`;

  const r2 = await fetch(videoUrl);
  const data2 = await r2.json();
  if (!r2.ok || !data2.items?.length) return null;

  const snip = data2.items[0].snippet;

  return {
    videoId,
    title: snip?.title || "",
    published: snip?.publishedAt || "",
    description: snip?.description || "",
    link: `https://www.youtube.com/watch?v=${videoId}`,
  };
}


// Debug route
app.get("/api/debug/youtube", async (req, res) => {
  const envStatus = {
    GEMINI_API_KEY_set: !!process.env.GEMINI_API_KEY,
    YT_CHANNEL_ID_set: !!process.env.YT_CHANNEL_ID,
    YT_CHANNEL_ID_value: process.env.YT_CHANNEL_ID || null,
    YT_API_KEY_set: !!process.env.YT_API_KEY,
    YT_API_KEY_preview: process.env.YT_API_KEY ? process.env.YT_API_KEY.slice(0, 4) + "..." : null,
  };

  if (!YT_KEY || !CHANNEL_ID) {
    return res.status(400).json({
      ok: false,
      step: "env",
      envStatus,
      error: "Missing YT_CHANNEL_ID or YT_API_KEY on Render",
    });
  }

  const latest = await getLatestEpisodeFromYouTube();
  if (!latest) {
    return res.json({ ok: false, step: "fetch_latest", envStatus });
  }

  return res.json({
    ok: true,
    envStatus,
    latest: { title: latest.title, publishedAt: latest.published },
  });
});

// Main chatbot route
app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = (req.body.prompt || "").trim();

    //Latest episode (always real)
    if (isLatestEpisodeQuestion(userPrompt)) {
      const latest = await getLatestEpisodeFromYouTube();

      if (!latest) {
        return res.json(wrapTextAsGemini("I couldn’t fetch the latest episode right now."));
      }

      lastEpisodeContext = { ...latest, updatedAt: Date.now() };

      const msg =
        `🎙️ Latest AI With Arun Show episode:\n\n` +
        `• Title: ${latest.title}\n` +
        `• Published: ${latest.published}\n` +
        `• Watch: ${latest.link}\n\n` +
        `Ask: “What was this episode about?”`;

      return res.json(wrapTextAsGemini(msg));
    }

    // “What was this episode about?” (grounded in the real description)
    if (isEpisodeAboutQuestion(userPrompt)) {
      if (!lastEpisodeContext) {
        return res.json(wrapTextAsGemini('Ask “What is the latest episode?” first.'));
      }

      const { title, published, link, description } = lastEpisodeContext;

      // If description is empty, avoid hallucinating
      if (!description || description.trim().length < 20) {
        return res.json(
          wrapTextAsGemini(
            `I can’t summarize this episode accurately because YouTube didn’t provide a usable description.\n\nTitle: ${title}\nWatch: ${link}`
          )
        );
      }

      // Use Gemini ONLY to summarize the provided description, with strict grounding
      const summaryPrompt = `
You are summarizing a YouTube episode.
Use ONLY the DESCRIPTION below. Do NOT add any details not present in the description.
If something isn't stated, say: "Not specified in the description."

Title: ${title}
Published: ${published}
Link: ${link}

DESCRIPTION:
${description}

Return:
1) A 2–4 sentence summary
2) 3 bullet key takeaways
`.trim();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        // If Gemini fails, still respond gracefully
        return res.json(
          wrapTextAsGemini(
            `Here’s the official YouTube description (so you still get the real info):\n\n${description}\n\nWatch: ${link}`
          )
        );
      }

      return res.json(data);
    }

    // Everything else -> normal Gemini, but gently scoped
    const system = `
You are the assistant for the AI With Arun Show website.
Be accurate and do not invent episode details.
If the user asks about the latest episode, tell them to ask: "What is the latest episode?"
If the user asks what the latest episode was about, tell them to ask: "What was this episode about?"
Keep responses concise.
`.trim();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `SYSTEM:\n${system}\n\nUSER:\n${userPrompt}` }] },
          ],
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { message: String(err) } });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

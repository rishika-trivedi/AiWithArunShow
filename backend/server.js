import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

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
// ENV HELPERS (robust)
// =====================

// Returns the first env var found among candidates (handles common naming mistakes)
function readEnvAny(...keys) {
  for (const k of keys) {
    // exact
    if (process.env[k]) return process.env[k];

    // handle accidental whitespace in key names on Render
    const foundKey = Object.keys(process.env).find(
      (ek) => ek.trim() === k && process.env[ek]
    );
    if (foundKey) return process.env[foundKey];
  }
  return undefined;
}

const GEMINI_KEY = readEnvAny("GEMINI_API_KEY");
const YT_KEY = readEnvAny("YT_API_KEY", "YT_APIKEY", "YOUTUBE_API_KEY", "YT_KEY");
const CHANNEL_ID = readEnvAny("YT_CHANNEL_ID", "YOUTUBE_CHANNEL_ID", "CHANNEL_ID");

// Print which YT env keys exist (safe: no values)
console.log("BOOT ENV CHECK:", {
  hasGemini: !!GEMINI_KEY,
  hasYT: !!YT_KEY,
  hasChan: !!CHANNEL_ID,
  ytEnvKeysPresent: Object.keys(process.env).filter((k) => k.toUpperCase().includes("YT")),
});

// =====================
// CONFIG / STATE
// =====================
let lastEpisodeContext = null;
// { title, published, link, description, updatedAt }

// =====================
// HELPERS
// =====================
function wrapTextAsGemini(text) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

function isLatestEpisodeQuestion(prompt = "") {
  const t = prompt.toLowerCase();
  const wantsLatest =
    t.includes("latest") ||
    t.includes("newest") ||
    t.includes("most recent") ||
    t.includes("recent episode") ||
    t.includes("last episode") ||
    t.includes("last upload") ||
    t.includes("latest video") ||
    t.includes("new video");
  const hasEpisodeWord =
    t.includes("episode") || t.includes("episde") || t.includes("video") || t.includes("upload");
  return wantsLatest && hasEpisodeWord;
}

function isEpisodeAboutQuestion(prompt = "") {
  const t = prompt.toLowerCase();
  return (
    t.includes("what was this episode about") ||
    t.includes("what is this episode about") ||
    t.includes("what was it about") ||
    t.includes("what is it about") ||
    t.includes("tell me about this episode") ||
    t.includes("summarize it") ||
    t.includes("summary") ||
    t.includes("recap")
  );
}

async function getLatestEpisodeFromYouTube() {
  if (!YT_KEY || !CHANNEL_ID) return { ok: false, reason: "missing_env" };

  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet` +
    `&channelId=${encodeURIComponent(CHANNEL_ID)}` +
    `&order=date&maxResults=1&type=video&key=${encodeURIComponent(YT_KEY)}`;

  const r = await fetch(url);
  const data = await r.json().catch(() => null);

  if (!r.ok) {
    return { ok: false, reason: "youtube_api_error", status: r.status, data };
  }

  if (!data?.items?.length) {
    return { ok: false, reason: "no_items", data };
  }

  const item = data.items[0];
  const videoId = item?.id?.videoId;

  return {
    ok: true,
    episode: {
      title: item?.snippet?.title || "",
      published: item?.snippet?.publishedAt || "",
      link: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
      description: item?.snippet?.description || "",
    },
  };
}

// =====================
// ROUTES
// =====================

// Debug route: tells you exactly what Render injected
app.get("/api/debug/youtube", async (req, res) => {
  const envStatus = {
    GEMINI_API_KEY_set: !!GEMINI_KEY,
    YT_CHANNEL_ID_set: !!CHANNEL_ID,
    YT_CHANNEL_ID_value: CHANNEL_ID || null,
    YT_API_KEY_set: !!YT_KEY,
    YT_API_KEY_preview: YT_KEY ? YT_KEY.slice(0, 4) + "..." : null,
    ytEnvKeysPresent: Object.keys(process.env).filter((k) => k.toUpperCase().includes("YT")),
  };

  if (!CHANNEL_ID || !YT_KEY) {
    return res.status(400).json({
      ok: false,
      step: "env",
      envStatus,
      error:
        "Missing YT_CHANNEL_ID or YT_API_KEY. This is not a code problem — set these on the Render WEB SERVICE Environment tab, then redeploy.",
    });
  }

  const result = await getLatestEpisodeFromYouTube();
  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      step: "youtube_fetch",
      envStatus,
      result,
    });
  }

  return res.json({
    ok: true,
    envStatus,
    latest: {
      title: result.episode.title,
      published: result.episode.published,
      link: result.episode.link,
      descriptionPreview: (result.episode.description || "").slice(0, 120) + "...",
    },
  });
});

// Chat route
app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = (req.body.prompt || "").trim();

    // Latest episode (use YouTube as source of truth)
    if (isLatestEpisodeQuestion(userPrompt)) {
      const result = await getLatestEpisodeFromYouTube();

      if (!result.ok) {
        // Give a SPECIFIC error so you’re not guessing
        if (result.reason === "missing_env") {
          return res.json(
            wrapTextAsGemini(
              "Backend missing YT_API_KEY or YT_CHANNEL_ID. Open /api/debug/youtube to see what’s missing."
            )
          );
        }
        if (result.reason === "youtube_api_error") {
          const msg =
            result?.data?.error?.message ||
            `YouTube API error ${result.status}. Check API enabled + quota + key restrictions.`;
          return res.json(wrapTextAsGemini(`Couldn’t fetch latest episode. ${msg}`));
        }
        return res.json(wrapTextAsGemini("Couldn’t fetch the latest episode right now."));
      }

      const latest = result.episode;
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

    // “What was this episode about?”
    if (isEpisodeAboutQuestion(userPrompt)) {
      if (!lastEpisodeContext) {
        return res.json(wrapTextAsGemini('Ask “What is the latest episode?” first.'));
      }

      const { title, published, link, description } = lastEpisodeContext;

      if (!GEMINI_KEY) {
        return res.json(
          wrapTextAsGemini("Backend missing GEMINI_API_KEY. Add it on Render then redeploy.")
        );
      }

      if (!description || description.length < 20) {
        return res.json(
          wrapTextAsGemini("This video’s description is too short to summarize accurately.")
        );
      }

      const summaryPrompt = `
You are summarizing a YouTube episode.
Use ONLY the description below. Do NOT add facts.
If something isn’t in the description, say “Not specified in the description.”

Title: ${title}
Published: ${published}
Link: ${link}

Description:
${description}

Return:
1) 3–5 sentence summary
2) 3 bullet key takeaways
`.trim();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
          GEMINI_KEY
        )}`,
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

    // Default fallback (optional)
    return res.json(
      wrapTextAsGemini(
        "Try asking: “What is the latest episode?” or “What was this episode about?”"
      )
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: String(err) } });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

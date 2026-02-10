import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ENV
const YT_KEY = process.env.YT_API_KEY;
const CHANNEL_ID = process.env.YT_CHANNEL_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Context memory (so follow-ups work)
let lastEpisodeContext = null;
// {
//   mode: "latest" | "popular" | "topic" | "person",
//   title, published, description, link, videoId,
//   list: [{title, link, published, views, description}],
//   query: "robotics" | "joe reis" | ...
//   updatedAt
// }

// --------------------
// Helpers
// --------------------
function wrapTextAsGemini(text) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

function normalize(s = "") {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatISODate(iso = "") {
  // Keep it simple (you can format nicer later)
  return iso ? iso : "";
}

function containsAny(t, arr) {
  return arr.some((w) => t.includes(w));
}

// --------------------
// Intent detectors
// --------------------
function isLatestEpisodeQuestion(prompt = "") {
  const t = normalize(prompt);
  const wantsLatest =
    containsAny(t, ["latest", "newest", "most recent", "recent", "last"]) &&
    containsAny(t, ["episode", "video", "upload", "show", "podcast"]);
  // also catch short versions like "latest episode?"
  return wantsLatest;
}

function isEpisodeAboutQuestion(prompt = "") {
  const t = normalize(prompt);
  return containsAny(t, [
    "what was this episode about",
    "what is this episode about",
    "what was it about",
    "what is it about",
    "tell me about this episode",
    "tell me about it",
    "summarize it",
    "summarize",
    "summary",
    "recap",
    "what is this about",
    "what was that about",
    "what is that about",
  ]);
}

function isPopularVideosQuestion(prompt = "") {
  const t = normalize(prompt);
  return containsAny(t, [
    "most popular",
    "popular videos",
    "top videos",
    "top episodes",
    "most viewed",
    "highest views",
    "best performing",
    "biggest videos",
    "best videos",
  ]);
}

function extractTopic(prompt = "") {
  const t = normalize(prompt);

  // super common patterns:
  // "videos about robotics", "episodes on education", "show me ai in politics videos"
  const match =
    t.match(/(about|on|related to|regarding|around)\s+([a-z0-9 \-]{2,50})$/i) ||
    t.match(/videos?\s+(about|on)\s+([a-z0-9 \-]{2,50})/i) ||
    t.match(/episodes?\s+(about|on)\s+([a-z0-9 \-]{2,50})/i);

  if (match && match[2]) return match[2].trim();

  // also allow “robotics videos” “education episodes”
  const quick = t.match(/^(robotics|education|politics|ethics|healthcare|data|security|cyber|startups|saas|ml|ai)\s+(videos?|episodes?)$/i);
  if (quick && quick[1]) return quick[1].trim();

  return null;
}

function isTopicVideosQuestion(prompt = "") {
  const t = normalize(prompt);
  // detect “videos about X” / “episodes on X” etc.
  if (containsAny(t, ["videos about", "video about", "episodes about", "episode about", "videos on", "episodes on"])) {
    return true;
  }
  // detect topic extraction
  return !!extractTopic(prompt);
}

function extractPerson(prompt = "") {
  const t = normalize(prompt);

  // patterns:
  // "videos with joe reis", "episodes with arun", "show me interviews with X"
  const m =
    t.match(/(with|featuring|feat\.?|ft\.?|interview with|guest)\s+([a-z0-9 \-]{2,50})$/i) ||
    t.match(/(with|featuring|feat\.?|ft\.?|interview with|guest)\s+([a-z0-9 \-]{2,50})/i);

  if (m && m[2]) return m[2].trim();
  return null;
}

function isPersonVideosQuestion(prompt = "") {
  const t = normalize(prompt);
  return (
    containsAny(t, ["videos with", "episodes with", "interview with", "guest", "featuring", "feat", "ft"]) &&
    !!extractPerson(prompt)
  );
}

// --------------------
// YouTube API
// --------------------
async function ytFetchJson(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

async function getLatestEpisodeFromYouTube() {
  if (!YT_KEY || !CHANNEL_ID) return null;

  // newest videoId
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&channelId=${CHANNEL_ID}&order=date&maxResults=1&type=video&key=${YT_KEY}`;

  const { ok: ok1, data: data1 } = await ytFetchJson(searchUrl);
  if (!ok1 || !data1?.items?.length) return null;

  const videoId = data1.items[0]?.id?.videoId;
  if (!videoId) return null;

  // full snippet
  const videoUrl =
    `https://www.googleapis.com/youtube/v3/videos?` +
    `part=snippet,statistics&id=${videoId}&key=${YT_KEY}`;

  const { ok: ok2, data: data2 } = await ytFetchJson(videoUrl);
  if (!ok2 || !data2?.items?.length) return null;

  const item = data2.items[0];
  const snip = item.snippet || {};
  const stats = item.statistics || {};

  return {
    videoId,
    title: snip.title || "",
    published: snip.publishedAt || "",
    description: snip.description || "",
    views: stats.viewCount ? Number(stats.viewCount) : null,
    link: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

async function getRecentVideos(limit = 20) {
  if (!YT_KEY || !CHANNEL_ID) return [];

  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&channelId=${CHANNEL_ID}&order=date&maxResults=${limit}&type=video&key=${YT_KEY}`;

  const { ok, data } = await ytFetchJson(searchUrl);
  if (!ok || !data?.items?.length) return [];

  const ids = data.items.map((it) => it?.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  // fetch full snippets + stats for these ids
  const videoUrl =
    `https://www.googleapis.com/youtube/v3/videos?` +
    `part=snippet,statistics&id=${ids.join(",")}&maxResults=${ids.length}&key=${YT_KEY}`;

  const { ok: ok2, data: data2 } = await ytFetchJson(videoUrl);
  if (!ok2 || !data2?.items?.length) return [];

  return data2.items.map((item) => {
    const snip = item.snippet || {};
    const stats = item.statistics || {};
    const vid = item.id;
    return {
      videoId: vid,
      title: snip.title || "",
      published: snip.publishedAt || "",
      description: snip.description || "",
      views: stats.viewCount ? Number(stats.viewCount) : 0,
      link: `https://www.youtube.com/watch?v=${vid}`,
    };
  });
}

async function getPopularVideos(limit = 6) {
  // easiest: take recent set, sort by viewCount
  const recent = await getRecentVideos(25);
  if (!recent.length) return [];

  const sorted = [...recent].sort((a, b) => (b.views || 0) - (a.views || 0));
  return sorted.slice(0, limit);
}

function filterVideosByTopic(videos, topic) {
  const t = normalize(topic);
  if (!t) return [];

  // simple keyword match in title + description
  return videos.filter((v) => {
    const hay = normalize(`${v.title} ${v.description}`);
    return hay.includes(t);
  });
}

function filterVideosByPerson(videos, person) {
  const p = normalize(person);
  if (!p) return [];
  return videos.filter((v) => {
    const hay = normalize(`${v.title} ${v.description}`);
    return hay.includes(p);
  });
}

function formatVideoList(videos, header = "") {
  if (!videos.length) return `${header}\n\nNo matching videos found.`;

  const lines = videos.map((v, i) => {
    const views = typeof v.views === "number" ? ` • ${v.views.toLocaleString()} views` : "";
    return `${i + 1}) ${v.title}\n   ${formatISODate(v.published)}${views}\n   ${v.link}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
}

// --------------------
// Gemini summarizer (grounded)
// --------------------
async function geminiSummarizeFromText({ title, published, link, description }) {
  const desc = (description || "").trim();
  if (!desc || desc.length < 20) {
    return wrapTextAsGemini(
      `I can’t summarize this episode accurately because YouTube didn’t provide a usable description.\n\nTitle: ${title}\nWatch: ${link}`
    );
  }

  const summaryPrompt = `
You are summarizing a YouTube episode.
Use ONLY the DESCRIPTION below. Do NOT add any details not present in the description.
If something isn't stated, say: "Not specified in the description."

Title: ${title}
Published: ${published}
Link: ${link}

DESCRIPTION:
${desc}

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

  const data = await response.json().catch(() => null);

  if (!response.ok || !data) {
    return wrapTextAsGemini(
      `Here’s the official YouTube description (real source):\n\n${desc}\n\nWatch: ${link}`
    );
  }

  return data;
}

// --------------------
// Debug route
// --------------------
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
  if (!latest) return res.json({ ok: false, step: "fetch_latest", envStatus });

  return res.json({
    ok: true,
    envStatus,
    latest: { title: latest.title, publishedAt: latest.published, views: latest.views },
  });
});

// --------------------
// Main chatbot route
// --------------------
app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = (req.body.prompt || "").trim();

    // 1) Latest episode (real)
    if (isLatestEpisodeQuestion(userPrompt)) {
      const latest = await getLatestEpisodeFromYouTube();
      if (!latest) return res.json(wrapTextAsGemini("I couldn’t fetch the latest episode right now."));

      lastEpisodeContext = { mode: "latest", ...latest, updatedAt: Date.now() };

      const msg =
        `🎙️ Latest AI With Arun Show episode:\n\n` +
        `• Title: ${latest.title}\n` +
        `• Published: ${latest.published}\n` +
        `• Watch: ${latest.link}\n\n` +
        `Ask: “What was this episode about?”`;

      return res.json(wrapTextAsGemini(msg));
    }

    // 2) Most popular videos (real)
    if (isPopularVideosQuestion(userPrompt)) {
      const popular = await getPopularVideos(6);
      if (!popular.length) return res.json(wrapTextAsGemini("I couldn’t fetch popular videos right now."));

      lastEpisodeContext = { mode: "popular", list: popular, query: "popular", updatedAt: Date.now() };

      const msg = formatVideoList(popular, "🔥 Most popular recent videos (by views):");
      return res.json(wrapTextAsGemini(msg + `\n\nYou can also ask: “Tell me about #1” or “Summarize the top one.”`));
    }

    // 3) Topic videos (real filtering)
    if (isTopicVideosQuestion(userPrompt)) {
      const topic = extractTopic(userPrompt) || "";
      const recent = await getRecentVideos(25);
      const matches = filterVideosByTopic(recent, topic).slice(0, 8);

      lastEpisodeContext = { mode: "topic", list: matches, query: topic, updatedAt: Date.now() };

      if (!matches.length) {
        return res.json(
          wrapTextAsGemini(`I looked at recent uploads but didn’t find matches for: "${topic}". Try a different keyword (ex: "robot", "education", "policy", "data").`)
        );
      }

      const msg = formatVideoList(matches, `🎯 Videos about “${topic}” (from recent uploads):`);
      return res.json(wrapTextAsGemini(msg + `\n\nAsk: “Tell me about #2” or “Summarize #1.”`));
    }

    // 4) Person/guest videos (real filtering)
    if (isPersonVideosQuestion(userPrompt)) {
      const person = extractPerson(userPrompt) || "";
      const recent = await getRecentVideos(25);
      const matches = filterVideosByPerson(recent, person).slice(0, 8);

      lastEpisodeContext = { mode: "person", list: matches, query: person, updatedAt: Date.now() };

      if (!matches.length) {
        return res.json(
          wrapTextAsGemini(`I checked recent uploads but didn’t find videos matching: "${person}". Try the full name as it appears in the title.`)
        );
      }

      const msg = formatVideoList(matches, `👤 Videos with/mentioning “${person}” (from recent uploads):`);
      return res.json(wrapTextAsGemini(msg + `\n\nAsk: “Tell me about #1” or “Summarize #3.”`));
    }

    // 5) Follow-up: "what was it about?" -> summarize last context safely
    if (isEpisodeAboutQuestion(userPrompt)) {
      if (!lastEpisodeContext) {
        return res.json(wrapTextAsGemini('Ask “What is the latest episode?” or “What are the most popular videos?” first.'));
      }

      // If last context is a single episode
      if (lastEpisodeContext.videoId) {
        return res.json(
          await geminiSummarizeFromText({
            title: lastEpisodeContext.title,
            published: lastEpisodeContext.published,
            link: lastEpisodeContext.link,
            description: lastEpisodeContext.description,
          })
        );
      }

      // If last context is a list (popular/topic/person), summarize #1 by default
      const list = lastEpisodeContext.list || [];
      if (!list.length) {
        return res.json(wrapTextAsGemini("I don’t have a recent list to summarize. Ask for popular/topic videos first."));
      }

      const top = list[0];
      return res.json(
        await geminiSummarizeFromText({
          title: top.title,
          published: top.published,
          link: top.link,
          description: top.description,
        })
      );
    }

    // 6) Follow-up: "tell me about #2" / "summarize 3"
    const t = normalize(userPrompt);
    const idxMatch = t.match(/(#|number\s*)(\d+)/i) || t.match(/summarize\s+(\d+)/i) || t.match(/about\s+(\d+)/i);
    if (idxMatch && lastEpisodeContext?.list?.length) {
      const n = Number(idxMatch[idxMatch.length - 1]);
      const list = lastEpisodeContext.list;
      if (Number.isFinite(n) && n >= 1 && n <= list.length) {
        const v = list[n - 1];
        return res.json(
          await geminiSummarizeFromText({
            title: v.title,
            published: v.published,
            link: v.link,
            description: v.description,
          })
        );
      }
    }

    // 7) Everything else -> normal Gemini, but scoped
    const system = `
You are the assistant for the AI With Arun Show website.
Be accurate and do not invent episode/video details.
If asked for popular videos, the user can ask: "What are the most popular videos?"
If asked for a topic, user can ask: "Show videos about robotics/education/politics/etc."
If asked for a person, user can ask: "Show videos with Joe Reis" (or any name).
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

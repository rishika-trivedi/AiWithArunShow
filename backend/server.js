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
//   mode: "latest" | "popular" | "topic" | "person" | "guests" | "guest_topic" | "guest_person_check",
//   title, published, description, link, videoId,
//   list: [{title, link, published, views, description}],
//   query: "robotics" | "joe reis" | ...,
//   guests: ["Joe Reis", ...]
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
  return iso ? iso : "";
}

function containsAny(t, arr) {
  return arr.some((w) => t.includes(w));
}

function safePreviewKey(k = "") {
  if (!k) return null;
  return k.slice(0, 4) + "...";
}

// --------------------
// STOPLIST for topic extraction (FIXES "the show")
// --------------------
const STOP_TOPICS = new Set([
  "the show",
  "this show",
  "your show",
  "show",
  "the podcast",
  "podcast",
  "the episode",
  "this episode",
  "episode",
  "episodes",
  "video",
  "videos",
  "latest",
  "newest",
  "most recent",
  "recent",
  "last",
  "upload",
  "uploads",
  "channel",
]);

// --------------------
// Intent detectors
// --------------------
function isLatestEpisodeQuestion(prompt = "") {
  const t = normalize(prompt);
  return (
    containsAny(t, ["latest", "newest", "most recent", "recent", "last"]) &&
    containsAny(t, ["episode", "video", "upload", "show", "podcast"])
  );
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

// ✅ REPLACED extractTopic() so it won't treat "the show" as a topic
function extractTopic(prompt = "") {
  const t = normalize(prompt);

  // patterns: "... about robotics", "videos about education", "episodes on politics"
  const match =
    t.match(/(about|on|related to|regarding|around)\s+([a-z0-9 \-]{2,50})$/i) ||
    t.match(/(videos?|episodes?|guests?)\s+(about|on)\s+([a-z0-9 \-]{2,50})/i);

  let topic = null;

  if (match) {
    // match[3] is the topic for "(videos|episodes) about X"
    // match[2] is the topic for "about X" at the end
    topic = (match[3] || match[2] || "").trim();
  }

  // allow “robotics videos”, “education episodes”
  if (!topic) {
    const quick = t.match(
      /^(robotics|education|politics|ethics|healthcare|data|security|cyber|startups|saas|ml|ai)\s+(videos?|episodes?|guests?)$/i
    );
    if (quick && quick[1]) topic = quick[1].trim();
  }

  if (!topic) return null;

  topic = topic.replace(/^["']|["']$/g, "").trim(); // strip quotes
  if (topic.length < 3) return null;
  if (STOP_TOPICS.has(topic)) return null;

  return topic;
}

function isTopicVideosQuestion(prompt = "") {
  const t = normalize(prompt);
  if (
    containsAny(t, [
      "videos about",
      "video about",
      "episodes about",
      "episode about",
      "videos on",
      "episodes on",
    ])
  ) {
    return true;
  }
  return !!extractTopic(prompt);
}

function extractPerson(prompt = "") {
  const t = normalize(prompt);

  const m =
    t.match(
      /(with|featuring|feat\.?|ft\.?|interview with|guest)\s+([a-z0-9 \-]{2,50})$/i
    ) ||
    t.match(
      /(with|featuring|feat\.?|ft\.?|interview with|guest)\s+([a-z0-9 \-]{2,50})/i
    );

  if (m && m[2]) return m[2].trim();
  return null;
}

function isPersonVideosQuestion(prompt = "") {
  const t = normalize(prompt);
  return (
    containsAny(t, [
      "videos with",
      "episodes with",
      "interview with",
      "guest",
      "featuring",
      "feat",
      "ft",
    ]) && !!extractPerson(prompt)
  );
}

// NEW: guest intents (safe mode: only names in title/description)
function isGuestsListQuestion(prompt = "") {
  const t = normalize(prompt);
  return containsAny(t, [
    "who are the guests",
    "who were the guests",
    "list guests",
    "guest list",
    "guests on the show",
    "who has been on the show",
    "who appeared on the show",
    "who has been on",
    "who was on",
  ]);
}

// NEW: “guests about robotics / education / politics”
function isGuestsByTopicQuestion(prompt = "") {
  const t = normalize(prompt);
  return (
    containsAny(t, ["guests", "guest"]) &&
    (containsAny(t, ["about", "on", "related to", "regarding"]) || !!extractTopic(prompt))
  );
}

// NEW: “Has ___ been on the show?”
function extractHasPerson(prompt = "") {
  const t = normalize(prompt);
  const m =
    t.match(/has\s+([a-z0-9 \-]{2,60})\s+been on/i) ||
    t.match(/was\s+([a-z0-9 \-]{2,60})\s+on the show/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function isHasPersonQuestion(prompt = "") {
  const t = normalize(prompt);
  return (
    ((t.includes("has") && t.includes("been on")) ||
      t.includes("was") ||
      t.includes("on the show")) &&
    !!extractHasPerson(prompt)
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

  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&channelId=${CHANNEL_ID}&order=date&maxResults=1&type=video&key=${YT_KEY}`;

  const { ok: ok1, data: data1 } = await ytFetchJson(searchUrl);
  if (!ok1 || !data1?.items?.length) return null;

  const videoId = data1.items[0]?.id?.videoId;
  if (!videoId) return null;

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
  const recent = await getRecentVideos(25);
  if (!recent.length) return [];
  const sorted = [...recent].sort((a, b) => (b.views || 0) - (a.views || 0));
  return sorted.slice(0, limit);
}

function filterVideosByTopic(videos, topic) {
  const t = normalize(topic);
  if (!t) return [];
  return videos.filter((v) => normalize(`${v.title} ${v.description}`).includes(t));
}

function filterVideosByPerson(videos, person) {
  const p = normalize(person);
  if (!p) return [];
  return videos.filter((v) => normalize(`${v.title} ${v.description}`).includes(p));
}

function formatVideoList(videos, header = "") {
  if (!videos.length) return `${header}\n\nNo matching videos found.`;

  const lines = videos.map((v, i) => {
    const views =
      typeof v.views === "number" ? ` • ${v.views.toLocaleString()} views` : "";
    return `${i + 1}) ${v.title}\n   ${formatISODate(v.published)}${views}\n   ${v.link}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
}

// --------------------
// Guest extraction (ONLY from title+description)
// --------------------
function extractGuestsFromText(text = "") {
  const guests = new Set();

  const patterns = [
    /\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\bft\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\bfeat\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\bfeaturing\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\bguest:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\binterview\s+with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    /\b—\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const name = (m[1] || "").trim();
      if (name.split(" ").length >= 2) guests.add(name);
    }
  }

  return [...guests];
}

async function getGuestsFromRecentVideos(limit = 25) {
  const vids = await getRecentVideos(limit);
  const guestToVideos = new Map();

  for (const v of vids) {
    const found = extractGuestsFromText(`${v.title}\n${v.description}`);
    for (const g of found) {
      if (!guestToVideos.has(g)) guestToVideos.set(g, []);
      guestToVideos.get(g).push(v);
    }
  }

  const guestsSorted = [...guestToVideos.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, videos]) => ({ name, count: videos.length, videos }));

  return { guestsSorted, vids };
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
    YT_API_KEY_preview: safePreviewKey(process.env.YT_API_KEY),
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

    // 3) Topic videos (real filtering)  ✅ fixed "the show" issue
    if (isTopicVideosQuestion(userPrompt)) {
      const topic = extractTopic(userPrompt);

      if (!topic) {
        return res.json(
          wrapTextAsGemini(
            `I couldn’t detect a real topic from that. Try: “videos about robotics”, “videos on education”, or “videos about politics”.`
          )
        );
      }

      const recent = await getRecentVideos(25);
      const matches = filterVideosByTopic(recent, topic).slice(0, 8);

      lastEpisodeContext = { mode: "topic", list: matches, query: topic, updatedAt: Date.now() };

      if (!matches.length) {
        return res.json(
          wrapTextAsGemini(
            `I looked at recent uploads but didn’t find matches for: "${topic}". Try a different keyword (ex: "robot", "education", "policy", "data").`
          )
        );
      }

      const msg = formatVideoList(matches, `🎯 Videos about “${topic}” (from recent uploads):`);
      return res.json(wrapTextAsGemini(msg + `\n\nAsk: “Tell me about #2” or “Summarize #1.”`));
    }

    // 4) Person videos (real filtering)
    if (isPersonVideosQuestion(userPrompt)) {
      const person = extractPerson(userPrompt) || "";
      const recent = await getRecentVideos(25);
      const matches = filterVideosByPerson(recent, person).slice(0, 8);

      lastEpisodeContext = { mode: "person", list: matches, query: person, updatedAt: Date.now() };

      if (!matches.length) {
        return res.json(
          wrapTextAsGemini(
            `I checked recent uploads but didn’t find videos matching: "${person}". Try the full name exactly as it appears in the title/description.`
          )
        );
      }

      const msg = formatVideoList(matches, `👤 Videos mentioning “${person}” (from recent uploads):`);
      return res.json(wrapTextAsGemini(msg + `\n\nAsk: “Tell me about #1” or “Summarize #3.”`));
    }

    // 5) Guests list (SAFE: only from title+description)
    if (isGuestsListQuestion(userPrompt)) {
      const { guestsSorted } = await getGuestsFromRecentVideos(30);

      if (!guestsSorted.length) {
        return res.json(
          wrapTextAsGemini(
            "Guests aren’t consistently listed in titles/descriptions, so I can’t reliably name them right now. If a guest is explicitly mentioned in a title/description, I can list them."
          )
        );
      }

      const top = guestsSorted.slice(0, 12);
      const msg =
        `🎤 Guests explicitly mentioned (from recent uploads):\n\n` +
        top.map((g, i) => `${i + 1}) ${g.name} (${g.count} video${g.count === 1 ? "" : "s"})`).join("\n") +
        `\n\nNote: This list only includes guests whose names appear in titles or descriptions.`;

      lastEpisodeContext = {
        mode: "guests",
        guests: top.map((g) => g.name),
        list: top.flatMap((g) => g.videos).slice(0, 20),
        query: "guests",
        updatedAt: Date.now(),
      };

      return res.json(wrapTextAsGemini(msg));
    }

    // 6) Guests by topic (SAFE)
    if (isGuestsByTopicQuestion(userPrompt)) {
      const topic = extractTopic(userPrompt) || "";
      const { guestsSorted } = await getGuestsFromRecentVideos(35);

      if (!topic) {
        return res.json(
          wrapTextAsGemini(`Tell me a topic, like: “guests about robotics” or “guests on education”.`)
        );
      }

      const matchingGuests = guestsSorted
        .map((g) => {
          const vids = g.videos.filter((v) =>
            normalize(`${v.title} ${v.description}`).includes(normalize(topic))
          );
          return { name: g.name, count: vids.length, videos: vids };
        })
        .filter((g) => g.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

      if (!matchingGuests.length) {
        return res.json(
          wrapTextAsGemini(
            `I didn’t find guest names explicitly mentioned in videos that match "${topic}" (within recent uploads). Try a broader keyword like "robot", "education", "policy", or "data".`
          )
        );
      }

      const msg =
        `🎯 Guests explicitly mentioned in videos matching “${topic}” (recent uploads):\n\n` +
        matchingGuests.map((g, i) => `${i + 1}) ${g.name} (${g.count} match${g.count === 1 ? "" : "es"})`).join("\n") +
        `\n\nNote: Guests are only listed when their names appear in titles/descriptions.`;

      lastEpisodeContext = {
        mode: "guest_topic",
        guests: matchingGuests.map((g) => g.name),
        list: matchingGuests.flatMap((g) => g.videos).slice(0, 20),
        query: topic,
        updatedAt: Date.now(),
      };

      return res.json(wrapTextAsGemini(msg));
    }

    // 7) “Has X been on the show?” (SAFE: check only title/description)
    if (isHasPersonQuestion(userPrompt)) {
      const person = extractHasPerson(userPrompt);
      const recent = await getRecentVideos(35);
      const matches = filterVideosByPerson(recent, person);

      if (!matches.length) {
        return res.json(
          wrapTextAsGemini(
            `I can’t confirm "${person}" from titles/descriptions in recent uploads. If their name isn’t explicitly written in the title or description, I won’t guess.`
          )
        );
      }

      const msg =
        `✅ Yes — "${person}" is explicitly mentioned in these videos (recent uploads):\n\n` +
        matches.slice(0, 5).map((v, i) => `${i + 1}) ${v.title}\n   ${v.link}`).join("\n\n") +
        `\n\nAsk: “Summarize #1” or “Tell me about #2”.`;

      lastEpisodeContext = { mode: "guest_person_check", list: matches.slice(0, 10), query: person, updatedAt: Date.now() };
      return res.json(wrapTextAsGemini(msg));
    }

    // 8) Follow-up: summarize last context safely
    if (isEpisodeAboutQuestion(userPrompt)) {
      if (!lastEpisodeContext) {
        return res.json(
          wrapTextAsGemini(
            'Ask “What is the latest episode?” or “What are the most popular videos?” or “Who are the guests?” first.'
          )
        );
      }

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

      const list = lastEpisodeContext.list || [];
      if (!list.length) {
        return res.json(
          wrapTextAsGemini("I don’t have a recent episode/video saved to summarize. Ask for latest/popular/topic first.")
        );
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

    // 9) Follow-up: "tell me about #2" / "summarize 3"
    const t = normalize(userPrompt);
    const idxMatch =
      t.match(/(#|number\s*)(\d+)/i) || t.match(/summarize\s+(\d+)/i) || t.match(/about\s+(\d+)/i);
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

    // 10) Everything else -> Gemini, but prevent guest hallucinations
    const system = `
You are the assistant for the AI With Arun Show website.

CRITICAL:
- Do NOT invent guest names.
- Only claim a person/guest appears if their name is explicitly present in a YouTube title or description.
- If the user asks about guests, tell them to ask: "Who are the guests on the show?" or "Has <name> been on the show?"

Other helpful queries:
- "What is the latest episode?"
- "What are the most popular videos?"
- "Show videos about robotics/education/politics"
- "Show videos with <name>"

Keep responses concise and factual.
`.trim();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `SYSTEM:\n${system}\n\nUSER:\n${userPrompt}` }] }],
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

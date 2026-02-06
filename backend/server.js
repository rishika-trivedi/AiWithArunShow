import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

/**
 * Guardrails config
 * - Allowlist: phrases that indicate the user is asking about AI With Arun Show / site.
 */
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

  // Block obvious off-topic requests
  if (BLOCKLIST.some((w) => text.includes(w))) return false;

  // Allow if it clearly matches show/site keywords
  if (ALLOWLIST.some((w) => text.includes(w))) return true;

  // Default: off-topic
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

app.post("/api/gemini", async (req, res) => {
  try {
    const userPrompt = req.body.prompt;

    // 1) Input guardrail (blocks off-topic before spending API calls)
    if (!isOnTopic(userPrompt)) {
      return res.json({
        guarded: true,
        message: OFF_TOPIC_MESSAGE,
      });
    }

    // 2) Call Gemini with a strong instruction to stay on-topic
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `SYSTEM:\n${SYSTEM_INSTRUCTION}\n\nUSER:\n${userPrompt}`,
                },
              ],
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

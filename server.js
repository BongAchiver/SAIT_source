import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "PASTE_OPENAI_API_KEY_HERE";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDc9b0sVNROYKpPD42hol2UzK5vyM_Ibkw";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_JWT_SECRET";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const db = new Database(path.join(__dirname, "chat.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_type TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'plain',
    meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_key_created
  ON messages(chat_key, created_at, id);
`);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeNickname(raw) {
  return (raw || "").trim();
}

function chatKeyFor(type, a, b) {
  if (type === "global") return "global";
  if (type === "favorite") return `favorite::${a}`;
  if (type === "ai") return `ai::${a}::${b}`;
  if (type === "dm") {
    const [u1, u2] = [a, b].sort((x, y) => x.localeCompare(y));
    return `dm::${u1}::${u2}`;
  }
  throw new Error("Unknown chat type");
}

function listUsers() {
  return db
    .prepare("SELECT nickname, created_at FROM users ORDER BY nickname COLLATE NOCASE ASC")
    .all();
}

function parseMeta(metaJson) {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

function mapRow(row) {
  return {
    id: row.id,
    chatType: row.chat_type,
    chatKey: row.chat_key,
    sender: row.sender,
    content: row.content,
    format: row.format,
    meta: parseMeta(row.meta_json),
    createdAt: row.created_at
  };
}

function insertMessage({ chatType, chatKey, sender, content, format = "plain", meta = null }) {
  const info = db
    .prepare(
      `INSERT INTO messages (chat_type, chat_key, sender, content, format, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(chatType, chatKey, sender, content, format, meta ? JSON.stringify(meta) : null);

  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid);
  return mapRow(row);
}

function getHistory(chatKey) {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE chat_key = ?
       ORDER BY datetime(created_at) ASC, id ASC`
    )
    .all(chatKey)
    .map(mapRow);
}

function getAiContext(chatKey, userNickname, limit = 12) {
  const rows = db
    .prepare(
      `SELECT sender, content
       FROM messages
       WHERE chat_key = ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(chatKey, limit)
    .reverse();

  return rows
    .map((row) => {
      const role = row.sender === userNickname ? "user" : "assistant";
      return {
        role,
        content: (row.content || "").toString()
      };
    })
    .filter((item) => item.content.trim().length > 0);
}

function broadcast(event, payload) {
  const data = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function ensureUserExists(nickname) {
  const user = db.prepare("SELECT nickname FROM users WHERE nickname = ?").get(nickname);
  if (!user) {
    throw new Error("User not found");
  }
}

function signToken(nickname) {
  return jwt.sign({ nickname }, JWT_SECRET, { expiresIn: "30d" });
}

function readBearerToken(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer (.+)$/i);
  return match ? match[1] : null;
}

function authRequired(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = jwt.verify(token, JWT_SECRET);
    const nickname = normalizeNickname(payload?.nickname);
    if (!nickname) return res.status(401).json({ error: "Unauthorized" });
    ensureUserExists(nickname);
    req.authUser = nickname;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function normalizeProxyUrl(value) {
  const raw = (value || "").toString().trim();
  if (!raw) return null;
  if (raw.length > 300) throw new Error("Proxy URL is too long");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid proxy URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Proxy URL must be http or https");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function parseAttachment(rawDataUrl, rawName, rawMimeType) {
  if (!rawDataUrl) return null;
  const dataUrl = rawDataUrl.toString();
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid attachment data");
  }

  const inferredMimeType = match[1] || "application/octet-stream";
  const base64Data = match[2];
  const bytes = Buffer.byteLength(base64Data, "base64");
  if (!bytes || bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachment is too large (max 8MB)");
  }

  const attachmentName = (rawName || "file").toString().trim().slice(0, 120) || "file";
  const mimeType = (rawMimeType || inferredMimeType).toString().trim().slice(0, 120) || inferredMimeType;

  return {
    name: attachmentName,
    mimeType,
    size: bytes,
    dataUrl
  };
}

async function callOpenAI({ text, imageDataUrl, proxyUrl, history }) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.includes("PASTE_")) {
    return "OpenAI API key не настроен на сервере.";
  }

  const input = [
    {
      role: "system",
      content:
        "Отвечай по-русски, используй markdown-форматирование (заголовки, списки, код-блоки), когда это уместно."
    },
    ...(Array.isArray(history) ? history : [])
  ];

  const content = [];
  if (text && text.trim()) content.push({ type: "input_text", text });
  if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl });
  if (!content.length) content.push({ type: "input_text", text: "Опиши изображение." });

  input.push({ role: "user", content });

  const baseUrl = proxyUrl || "https://api.openai.com";
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input
    })
  });

  if (!response.ok) {
    const body = await response.text();
    return `Ошибка OpenAI: ${response.status}. ${body.slice(0, 400)}`;
  }

  const data = await response.json();
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const texts = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  return texts.join("\n\n") || "Пустой ответ OpenAI.";
}

async function callGemini({ text, imageDataUrl, proxyUrl }) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE_")) {
    return "Gemini API key не настроен на сервере.";
  }

  const parts = [];
  if (text && text.trim()) {
    parts.push({ text });
  }

  if (imageDataUrl) {
    const match = imageDataUrl.match(/^data:(.+);base64,(.+)$/);
    if (match) {
      parts.push({
        inline_data: {
          mime_type: match[1],
          data: match[2]
        }
      });
    }
  }

  if (!parts.length) parts.push({ text: "Опиши изображение." });

  const baseUrl = proxyUrl || "https://generativelanguage.googleapis.com";
  const url = `${baseUrl}/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    return `Ошибка Gemini: ${response.status}. ${body.slice(0, 400)}`;
  }

  const data = await response.json();
  const result = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join("\n\n");

  return result || "Пустой ответ Gemini.";
}

app.post("/api/login", (req, res) => {
  const nickname = normalizeNickname(req.body?.nickname);
  if (!nickname) {
    return res.status(400).json({ error: "Nickname is required" });
  }

  db.prepare("INSERT OR IGNORE INTO users (nickname) VALUES (?)").run(nickname);

  const user = db.prepare("SELECT nickname, created_at FROM users WHERE nickname = ?").get(nickname);
  const token = signToken(nickname);
  broadcast("users:update", { users: listUsers() });

  return res.json({ user, users: listUsers(), token });
});

app.get("/api/users", (_req, res) => {
  return res.json({ users: listUsers() });
});

app.get("/api/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT nickname, created_at FROM users WHERE nickname = ?").get(req.authUser);
  return res.json({ user, users: listUsers() });
});

app.get("/api/history", authRequired, (req, res) => {
  try {
    const type = (req.query.type || "").toString();
    const nickname = req.authUser;
    const target = (req.query.target || "").toString();

    let chatKey;
    if (type === "global") chatKey = chatKeyFor("global");
    else if (type === "favorite") chatKey = chatKeyFor("favorite", nickname);
    else if (type === "dm") {
      const other = normalizeNickname(target);
      if (!other) return res.status(400).json({ error: "target is required" });
      chatKey = chatKeyFor("dm", nickname, other);
    } else if (type === "ai") {
      const provider = target === "gemini" ? "gemini" : "openai";
      chatKey = chatKeyFor("ai", nickname, provider);
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    return res.json({ messages: getHistory(chatKey) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/api/message", authRequired, (req, res) => {
  try {
    const type = (req.body.type || "").toString();
    const sender = req.authUser;
    const target = (req.body.target || "").toString();
    const content = (req.body.content || "").toString().trim();
    const attachment = parseAttachment(
      req.body.attachmentDataUrl,
      req.body.attachmentName,
      req.body.attachmentMimeType
    );

    if (!sender || (!content && !attachment)) {
      return res.status(400).json({ error: "sender and (content or attachment) are required" });
    }

    let chatType;
    let chatKey;

    if (type === "global") {
      chatType = "global";
      chatKey = chatKeyFor("global");
    } else if (type === "favorite") {
      chatType = "favorite";
      chatKey = chatKeyFor("favorite", sender);
    } else if (type === "dm") {
      const other = normalizeNickname(target);
      if (!other) return res.status(400).json({ error: "target is required" });
      ensureUserExists(other);
      chatType = "dm";
      chatKey = chatKeyFor("dm", sender, other);
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }

    const message = insertMessage({
      chatType,
      chatKey,
      sender,
      content: content || "[Вложение]",
      format: "plain",
      meta: attachment ? { attachment } : null
    });
    broadcast("message:new", { message });

    return res.json({ message });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete("/api/message/:id", authRequired, (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.id, 10);
    const requester = req.authUser;
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return res.status(400).json({ error: "Invalid message id" });
    }
    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    if (!row) {
      return res.status(404).json({ error: "Message not found" });
    }
    const message = mapRow(row);
    if (message.sender !== requester) {
      return res.status(403).json({ error: "You can delete only your own messages" });
    }

    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    broadcast("message:delete", {
      id: messageId,
      chatType: message.chatType,
      chatKey: message.chatKey
    });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/api/ai/send", authRequired, async (req, res) => {
  try {
    const nickname = req.authUser;
    const provider = req.body.provider === "gemini" ? "gemini" : "openai";
    const text = (req.body.text || "").toString();
    const imageDataUrl = req.body.imageDataUrl ? req.body.imageDataUrl.toString() : null;
    const proxyUrl = normalizeProxyUrl(req.body.proxyUrl);

    if (!text.trim() && !imageDataUrl) {
      return res.status(400).json({ error: "text or image is required" });
    }

    const chatKey = chatKeyFor("ai", nickname, provider);
    const history = provider === "openai" ? getAiContext(chatKey, nickname) : [];
    const userMessage = insertMessage({
      chatType: "ai",
      chatKey,
      sender: nickname,
      content: text.trim() || "[Изображение]",
      format: "plain",
      meta: {
        provider,
        hasImage: Boolean(imageDataUrl)
      }
    });

    broadcast("message:new", { message: userMessage });

    let aiText;
    if (provider === "gemini") {
      aiText = await callGemini({ text, imageDataUrl, proxyUrl });
    } else {
      aiText = await callOpenAI({ text, imageDataUrl, proxyUrl, history });
    }

    const aiMessage = insertMessage({
      chatType: "ai",
      chatKey,
      sender: provider === "gemini" ? "Gemini" : "ChatGPT",
      content: aiText,
      format: "markdown",
      meta: { provider }
    });

    broadcast("message:new", { message: aiMessage });
    return res.json({ userMessage, aiMessage });
  } catch (err) {
    return res.status(500).json({ error: err.message || "AI request failed" });
  }
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ event: "users:update", payload: { users: listUsers() } }));
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});

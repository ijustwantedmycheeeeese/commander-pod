// Separate, small admin app -- deliberately its own process/container, not a route bolted onto
// server.js. Runs in the same Docker stack (docker-compose.yml) but with its port bound only to
// 127.0.0.1 on the host, never published to 0.0.0.0 -- it's meant to be reachable ONLY over the
// operator's own network (e.g. via `tailscale serve` pointed at the loopback port), never from the
// public internet, even if the main game server's firewall/reverse-proxy setup changes later.
// Shares the same DATA_DIR/users.json the main server uses (same Docker volume), so approving or
// deleting a user here takes effect immediately -- server.js re-reads users.json fresh on every
// /api/register and /api/login rather than trusting a long-lived in-memory copy, specifically so
// this cross-process edit is never stale.
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const app = express();

app.use(express.static(path.join(__dirname, "admin-public")));
app.use(express.json({ limit: "1mb" }));

process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

const DATA_DIR = "/app/data";
const USERS_FILE = DATA_DIR + "/users.json";
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch (e) { return {}; }
}
function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); } catch (e) { console.error("Failed to save " + USERS_FILE, e); }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, salt, hash) {
  const test = Buffer.from(hashPassword(password, salt), "hex");
  const stored = Buffer.from(hash, "hex");
  if (test.length !== stored.length) return false;
  return crypto.timingSafeEqual(test, stored);
}

// The admin credential is intentionally NOT a player account -- it lives only in these two env
// vars (see docker-compose.yml), never in users.json, and never issues/accepts a player session
// token. Required at startup (no silent insecure default) the same way TURN_PASSWORD already is
// for the main server.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error("ADMIN_USERNAME and ADMIN_PASSWORD must both be set -- refusing to start with no admin credential configured.");
  process.exit(1);
}
// Hashed at startup, same scrypt+salt shape as player passwords, so the plaintext only ever exists
// transiently in the env var / process memory it already had to live in anyway (matching how
// TURN_PASSWORD is handled in this same compose file) rather than being compared in the clear.
const ADMIN_SALT = crypto.randomBytes(16).toString("hex");
const ADMIN_HASH = hashPassword(ADMIN_PASSWORD, ADMIN_SALT);

// Separate token space from server.js's player sessions -- an admin token is meaningless to the
// main game server and vice versa. In-memory only; restarting this container signs the admin out,
// which is fine for a tool used occasionally by one person.
let adminSessions = {}; // token -> createdAt
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h -- shorter-lived than player sessions on purpose, this grants real power
function adminAuthed(token) {
  const createdAt = token && adminSessions[token];
  if (!createdAt) return false;
  if (Date.now() - createdAt > ADMIN_SESSION_MAX_AGE_MS) { delete adminSessions[token]; return false; }
  return true;
}
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!adminAuthed(token)) return res.status(401).json({ success: false, error: "Not authenticated." });
  next();
}

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
let loginAttempts = { count: 0, firstAttemptAt: 0 };
function adminLoginLockedOut() {
  if (Date.now() - loginAttempts.firstAttemptAt > LOGIN_LOCKOUT_MS) { loginAttempts = { count: 0, firstAttemptAt: 0 }; return false; }
  return loginAttempts.count >= LOGIN_MAX_ATTEMPTS;
}

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (adminLoginLockedOut()) return res.json({ success: false, error: "Too many failed attempts. Try again in a few minutes." });
  if (username !== ADMIN_USERNAME || !verifyPassword(password || "", ADMIN_SALT, ADMIN_HASH)) {
    if (Date.now() - loginAttempts.firstAttemptAt > LOGIN_LOCKOUT_MS) loginAttempts = { count: 0, firstAttemptAt: Date.now() };
    loginAttempts.count++;
    return res.json({ success: false, error: "Incorrect username or password." });
  }
  loginAttempts = { count: 0, firstAttemptAt: 0 };
  const token = crypto.randomBytes(24).toString("hex");
  adminSessions[token] = Date.now();
  res.json({ success: true, token });
});

// Full user list, not just pending ones -- the operator explicitly wants to see everyone already
// approved too, to spot-check for an account they don't recognize and delete it.
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = loadUsers();
  const list = Object.keys(users).map((username) => ({
    username,
    approved: !!users[username].approved,
    createdAt: users[username].createdAt || null
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ success: true, users: list });
});

app.post("/api/admin/approve", requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const users = loadUsers();
  if (!users[username]) return res.json({ success: false, error: "No such user." });
  users[username].approved = true;
  saveUsers(users);
  res.json({ success: true });
});

// Reject == delete for a pending account (there's nothing else to "reject" -- it never had a
// session or any game data yet). Also used for "I don't recognize this approved user, remove them."
app.post("/api/admin/delete", requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const users = loadUsers();
  if (!users[username]) return res.json({ success: false, error: "No such user." });
  delete users[username];
  saveUsers(users);
  res.json({ success: true });
});

const PORT = process.env.ADMIN_PORT || 9091;
app.listen(PORT, () => console.log(`Admin panel listening on ${PORT} (bind this to 127.0.0.1 only in docker-compose -- never publish it publicly)`));

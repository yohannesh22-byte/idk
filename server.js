const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const twilio = require("twilio");
const { z } = require("zod");
require("dotenv").config();

const app = express();
const rootDir = __dirname;
const isProduction = process.env.NODE_ENV === "production";
const dbPath = process.env.DB_PATH || path.join(rootDir, "inventory.sqlite");
const jwtSecret = process.env.JWT_SECRET || "development-secret-change-before-production";
const authCookie = "inventory_auth";

if (isProduction && jwtSecret === "development-secret-change-before-production") {
  throw new Error("JWT_SECRET must be set in production.");
}

const config = {
  port: Number(process.env.PORT || 3000),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProduction,
  twilioEnabled: process.env.TWILIO_ENABLED !== "false",
  ownerUnlockMs: Number(process.env.OWNER_UNLOCK_MINUTES || 15) * 60 * 1000
};

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.join(rootDir, "db", "schema.sql"), "utf8"));

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://unpkg.com"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      mediaSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
}));
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(256)
});

const pinSchema = z.object({
  pin: z.string().trim().min(4).max(64)
});

const barcodeSchema = z.object({
  barcode: z.string().trim().min(1).max(128)
});

const registerScanSchema = z.object({
  barcode: z.string().trim().min(1).max(128),
  productName: z.string().trim().min(1).max(160),
  initialStock: z.number().int().min(0).max(1000000),
  description: z.string().trim().max(1000).default("")
});

const inventoryCreateSchema = z.object({
  barcode: z.string().trim().min(1).max(128),
  productName: z.string().trim().min(1).max(160),
  quantity: z.number().int().min(0).max(1000000),
  description: z.string().trim().max(1000).default("")
});

const inventoryUpdateSchema = z.object({
  productName: z.string().trim().min(1).max(160),
  quantity: z.number().int().min(0).max(1000000),
  description: z.string().trim().max(1000).default("")
});

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge
  };
}

function publicUser(user, ownerUnlocked) {
  return {
    id: user.id || user.sub,
    username: user.username,
    role: user.role,
    ownerUnlocked: Boolean(ownerUnlocked)
  };
}

function signSession(user, ownerUnlocked) {
  const csrfToken = crypto.randomUUID();
  const ownerUnlockedUntil = ownerUnlocked ? Date.now() + config.ownerUnlockMs : 0;
  const token = jwt.sign({
    sub: user.id,
    username: user.username,
    role: user.role,
    csrfToken,
    ownerUnlocked: Boolean(ownerUnlocked),
    ownerUnlockedUntil
  }, jwtSecret, { expiresIn: "8h" });
  return { token, csrfToken, ownerUnlockedUntil };
}

function issueSession(res, user, ownerUnlocked) {
  const session = signSession(user, ownerUnlocked);
  res.cookie(authCookie, session.token, cookieOptions(8 * 60 * 60 * 1000));
  return session;
}

function clearSession(res) {
  res.clearCookie(authCookie, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: "/"
  });
}

function attachUser(req, res, next) {
  const token = req.cookies[authCookie];
  if (!token) {
    next();
    return;
  }
  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    clearSession(res);
    next();
  }
}

function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/auth/login") {
    next();
    return;
  }
  if (!req.user) {
    next();
    return;
  }
  const headerToken = req.get("x-csrf-token");
  if (!headerToken || headerToken !== req.user.csrfToken) {
    res.status(403).json({ error: "Invalid CSRF token." });
    return;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  next();
}

function requireOwnerUnlocked(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (req.user.role !== "owner") {
    res.status(403).json({ error: "Owner role required." });
    return;
  }
  if (!req.user.ownerUnlocked || req.user.ownerUnlockedUntil < Date.now()) {
    res.status(403).json({ error: "Owner PIN unlock required." });
    return;
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function writeLog(entry) {
  db.prepare(`
    INSERT INTO logs (user_id, username, action, barcode, product_name, quantity_before, quantity_after, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.userId || null,
    entry.username || "system",
    entry.action,
    entry.barcode || null,
    entry.productName || null,
    Number.isInteger(entry.quantityBefore) ? entry.quantityBefore : null,
    Number.isInteger(entry.quantityAfter) ? entry.quantityAfter : null,
    JSON.stringify(entry.metadata || {})
  );
}

let twilioClient;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function getTwilioClient() {
  if (!config.twilioEnabled) {
    return null;
  }
  if (!twilioClient) {
    twilioClient = twilio(requiredEnv("TWILIO_ACCOUNT_SID"), requiredEnv("TWILIO_AUTH_TOKEN"), {
      autoRetry: true,
      maxRetries: 3,
      timeout: 10000
    });
  }
  return twilioClient;
}

async function sendSaleSms(productName, remainingStock) {
  if (!config.twilioEnabled) {
    return { sid: "twilio-disabled" };
  }
  const client = getTwilioClient();
  const message = await client.messages.create({
    from: requiredEnv("TWILIO_FROM_NUMBER"),
    to: requiredEnv("OWNER_PHONE_NUMBER"),
    body: `Inventory alert: ${productName} sold. Remaining stock count: ${remainingStock}.`
  });
  return { sid: message.sid };
}

function stockStatus(quantity) {
  if (quantity === 0) {
    return "out";
  }
  if (quantity <= 5) {
    return "low";
  }
  return "in";
}

app.use("/api", attachUser, csrfProtection);

app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const body = loginSchema.parse(req.body);
  const user = db.prepare("SELECT id, username, password_hash, role, active FROM users WHERE username = ?").get(body.username);

  if (!user || user.active !== 1 || !await bcrypt.compare(body.password, user.password_hash)) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  const session = issueSession(res, user, false);
  writeLog({ userId: user.id, username: user.username, action: "login_success" });

  res.json({
    user: publicUser(user, false),
    csrfToken: session.csrfToken,
    ownerUnlockedUntil: 0
  });
}));

app.get("/api/auth/me", requireAuth, (req, res) => {
  const ownerUnlocked = req.user.role === "owner" && req.user.ownerUnlocked && req.user.ownerUnlockedUntil > Date.now();
  res.json({
    user: publicUser(req.user, ownerUnlocked),
    csrfToken: req.user.csrfToken,
    ownerUnlockedUntil: ownerUnlocked ? req.user.ownerUnlockedUntil : 0
  });
});

app.post("/api/auth/owner-unlock", requireAuth, asyncRoute(async (req, res) => {
  if (req.user.role !== "owner") {
    res.status(403).json({ error: "Owner role required." });
    return;
  }

  const body = pinSchema.parse(req.body);
  const secret = db.prepare("SELECT pin_hash FROM owner_secrets WHERE user_id = ?").get(req.user.sub);

  if (!secret || !await bcrypt.compare(body.pin, secret.pin_hash)) {
    writeLog({ userId: req.user.sub, username: req.user.username, action: "owner_unlock_failed" });
    res.status(401).json({ error: "Invalid owner PIN." });
    return;
  }

  const user = { id: req.user.sub, username: req.user.username, role: req.user.role };
  const session = issueSession(res, user, true);
  writeLog({ userId: req.user.sub, username: req.user.username, action: "owner_unlock_success" });

  res.json({
    user: publicUser(user, true),
    csrfToken: session.csrfToken,
    ownerUnlockedUntil: session.ownerUnlockedUntil
  });
}));

app.post("/api/auth/logout", (req, res) => {
  if (req.user) {
    writeLog({ userId: req.user.sub, username: req.user.username, action: "logout" });
  }
  clearSession(res);
  res.json({ ok: true });
});

app.post("/api/scan/register", requireOwnerUnlocked, (req, res) => {
  const body = registerScanSchema.parse(req.body);
  const existing = db.prepare("SELECT id FROM inventory WHERE barcode = ?").get(body.barcode);

  if (existing) {
    res.status(409).json({ error: "This barcode is already registered." });
    return;
  }

  const result = db.prepare(`
    INSERT INTO inventory (barcode, product_name, quantity, description)
    VALUES (?, ?, ?, ?)
  `).run(body.barcode, body.productName, body.initialStock, body.description);

  writeLog({
    userId: req.user.sub,
    username: req.user.username,
    action: "item_registered",
    barcode: body.barcode,
    productName: body.productName,
    quantityAfter: body.initialStock
  });

  res.status(201).json({
    item: {
      id: result.lastInsertRowid,
      barcode: body.barcode,
      productName: body.productName,
      quantity: body.initialStock,
      description: body.description,
      status: stockStatus(body.initialStock)
    }
  });
});

app.post("/api/scan/sale", requireAuth, asyncRoute(async (req, res) => {
  const body = barcodeSchema.parse(req.body);

  db.exec("BEGIN IMMEDIATE");
  try {
    const item = db.prepare("SELECT id, barcode, product_name, quantity, description FROM inventory WHERE barcode = ?").get(body.barcode);

    if (!item) {
      db.exec("ROLLBACK");
      res.status(404).json({ error: "Item not found." });
      return;
    }

    if (item.quantity <= 0) {
      db.exec("ROLLBACK");
      res.status(409).json({ error: "Item is out of stock.", item: { barcode: item.barcode, productName: item.product_name, quantity: item.quantity } });
      return;
    }

    const remaining = item.quantity - 1;
    db.prepare("UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(remaining, item.id);

    writeLog({
      userId: req.user.sub,
      username: req.user.username,
      action: "sale",
      barcode: item.barcode,
      productName: item.product_name,
      quantityBefore: item.quantity,
      quantityAfter: remaining
    });

    const sms = await sendSaleSms(item.product_name, remaining);
    db.exec("COMMIT");

    res.json({
      ok: true,
      smsSid: sms.sid,
      item: {
        id: item.id,
        barcode: item.barcode,
        productName: item.product_name,
        quantity: remaining,
        description: item.description,
        status: stockStatus(remaining)
      }
    });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}));

app.get("/api/owner/inventory", requireOwnerUnlocked, (req, res) => {
  const rows = db.prepare(`
    SELECT id, barcode, product_name, quantity, description, created_at, updated_at
    FROM inventory
    ORDER BY product_name COLLATE NOCASE ASC
  `).all();

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      barcode: row.barcode,
      productName: row.product_name,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: stockStatus(row.quantity)
    }))
  });
});

app.post("/api/owner/inventory", requireOwnerUnlocked, (req, res) => {
  const body = inventoryCreateSchema.parse(req.body);
  const result = db.prepare(`
    INSERT INTO inventory (barcode, product_name, quantity, description)
    VALUES (?, ?, ?, ?)
  `).run(body.barcode, body.productName, body.quantity, body.description);

  writeLog({
    userId: req.user.sub,
    username: req.user.username,
    action: "item_created",
    barcode: body.barcode,
    productName: body.productName,
    quantityAfter: body.quantity
  });

  res.status(201).json({ id: result.lastInsertRowid });
});

app.put("/api/owner/inventory/:id", requireOwnerUnlocked, (req, res) => {
  const id = Number(req.params.id);
  const body = inventoryUpdateSchema.parse(req.body);
  const current = db.prepare("SELECT * FROM inventory WHERE id = ?").get(id);

  if (!current) {
    res.status(404).json({ error: "Item not found." });
    return;
  }

  db.prepare(`
    UPDATE inventory
    SET product_name = ?, quantity = ?, description = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(body.productName, body.quantity, body.description, id);

  writeLog({
    userId: req.user.sub,
    username: req.user.username,
    action: "item_updated",
    barcode: current.barcode,
    productName: body.productName,
    quantityBefore: current.quantity,
    quantityAfter: body.quantity
  });

  res.json({ ok: true });
});

app.delete("/api/owner/inventory/:id", requireOwnerUnlocked, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare("SELECT * FROM inventory WHERE id = ?").get(id);

  if (!current) {
    res.status(404).json({ error: "Item not found." });
    return;
  }

  db.prepare("DELETE FROM inventory WHERE id = ?").run(id);

  writeLog({
    userId: req.user.sub,
    username: req.user.username,
    action: "item_deleted",
    barcode: current.barcode,
    productName: current.product_name,
    quantityBefore: current.quantity
  });

  res.json({ ok: true });
});

app.get("/api/owner/logs", requireOwnerUnlocked, (req, res) => {
  const rows = db.prepare(`
    SELECT id, username, action, barcode, product_name, quantity_before, quantity_after, metadata, created_at
    FROM logs
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  res.json({
    logs: rows.map((row) => ({
      id: row.id,
      username: row.username,
      action: row.action,
      barcode: row.barcode,
      productName: row.product_name,
      quantityBefore: row.quantity_before,
      quantityAfter: row.quantity_after,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at
    }))
  });
});

app.use(express.static(path.join(rootDir, "public"), {
  maxAge: isProduction ? "1h" : 0,
  etag: true
}));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(rootDir, "public", "index.html"));
});

app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request body.", details: err.errors.map((item) => item.message) });
    return;
  }

  const message = isProduction ? "Server error." : err.message;
  res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`Inventory tracker listening on port ${config.port}`);
});

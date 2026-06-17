const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
require("dotenv").config();

const rootDir = path.join(__dirname, "..");
const dbPath = process.env.DB_PATH || path.join(rootDir, "inventory.sqlite");
const schemaPath = path.join(rootDir, "db", "schema.sql");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(schemaPath, "utf8"));

const ownerUsername = process.env.SEED_OWNER_USERNAME || "owner";
const ownerPassword = process.env.SEED_OWNER_PASSWORD || "OwnerPass!2026";
const workerUsername = process.env.SEED_WORKER_USERNAME || "worker";
const workerPassword = process.env.SEED_WORKER_PASSWORD || "WorkerPass!2026";
const ownerPin = process.env.SEED_OWNER_PIN || "493827";

const upsertUser = db.prepare(`
  INSERT INTO users (username, password_hash, role, active, updated_at)
  VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(username) DO UPDATE SET
    password_hash = excluded.password_hash,
    role = excluded.role,
    active = 1,
    updated_at = CURRENT_TIMESTAMP
`);

const findUser = db.prepare("SELECT id, username, role FROM users WHERE username = ?");
const upsertOwnerSecret = db.prepare(`
  INSERT INTO owner_secrets (user_id, pin_hash, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    pin_hash = excluded.pin_hash,
    updated_at = CURRENT_TIMESTAMP
`);

const seedInventory = db.prepare(`
  INSERT INTO inventory (barcode, product_name, quantity, description)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(barcode) DO NOTHING
`);

const insertLog = db.prepare(`
  INSERT INTO logs (user_id, username, action, barcode, product_name, quantity_before, quantity_after, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction(() => {
  upsertUser.run(ownerUsername, bcrypt.hashSync(ownerPassword, 12), "owner");
  upsertUser.run(workerUsername, bcrypt.hashSync(workerPassword, 12), "worker");

  const owner = findUser.get(ownerUsername);
  upsertOwnerSecret.run(owner.id, bcrypt.hashSync(ownerPin, 12));

  seedInventory.run("INV-0001", "Amethyst Starter Kit", 12, "Demo seeded item for camera or QR testing.");
  seedInventory.run("INV-0002", "Lavender Cable Pack", 5, "Demo low-stock item.");
  seedInventory.run("INV-0003", "Neon Label Roll", 0, "Demo out-of-stock item.");

  insertLog.run(owner.id, owner.username, "database_seeded", null, null, null, null, JSON.stringify({ seeded: true }));
});

tx();

console.log(`Database initialized at ${dbPath}`);
console.log(`Owner login: ${ownerUsername}`);
console.log(`Worker login: ${workerUsername}`);
console.log("Set SEED_OWNER_PASSWORD, SEED_WORKER_PASSWORD, and SEED_OWNER_PIN before production initialization.");

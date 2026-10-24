import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ORDER_QUANTITY = 100;

// A small custom error lets routes return useful HTTP status codes.
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function makePasswordHash(password, salt = randomBytes(16).toString('hex')) {
  // scrypt is a password-hashing algorithm available in Node.js itself.
  const passwordHash = scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash };
}

function passwordMatches(password, salt, storedHash) {
  const candidate = scryptSync(password, salt, 64);
  const original = Buffer.from(storedHash, 'hex');
  return candidate.length === original.length && timingSafeEqual(candidate, original);
}

function createTables(db) {
  // Foreign keys and non-negative stock are enforced by SQLite, not only by JavaScript.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      stock INTEGER NOT NULL CHECK (stock >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user_created
      ON orders(user_id, created_at DESC);
  `);
}

function seedProducts(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO products
      (name, description, category, price_cents, currency, stock, created_at)
    VALUES (?, ?, ?, ?, 'USD', ?, ?)
  `);

  const now = new Date().toISOString();
  const initialProducts = [
    ['Flash Sale Headphones', 'Wireless headphones with a limited sale quantity.', 'Electronics', 4999, 3],
    ['Mechanical Keyboard', 'Compact mechanical keyboard for everyday work.', 'Electronics', 7999, 5],
    ['USB-C Cable', 'One-metre USB-C charging cable.', 'Accessories', 999, 8],
    ['Desk Lamp', 'LED desk lamp for a home office.', 'Home', 2599, 1],
    ['Travel Mug', 'Reusable stainless-steel travel mug.', 'Home', 1899, 12],
  ];

  const seed = db.transaction(() => {
    for (const product of initialProducts) insert.run(...product, now);
  });
  seed();
}

function toProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    priceCents: row.price_cents,
    price: Number((row.price_cents / 100).toFixed(2)),
    currency: row.currency,
    stock: row.stock,
    inStock: row.stock > 0,
    createdAt: row.created_at,
  };
}

function toOrder(row, { idempotentReplay = false } = {}) {
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    productName: row.product_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    total: Number((row.total_cents / 100).toFixed(2)),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    ...(idempotentReplay ? { idempotentReplay: true } : {}),
  };
}

function publicUser(row) {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export function createApp({ dbPath = process.env.DB_PATH || path.join(__dirname, 'flash-sale.sqlite') } = {}) {
  const db = new Database(dbPath);
  createTables(db);
  seedProducts(db);

  // Remove expired sessions when the server starts.
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const findUserByUsername = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
  const findSession = db.prepare(`
    SELECT users.id, users.username, users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');

  // Authentication middleware: checks the bearer token on private routes.
  function requireAuth(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Send a valid token in the Authorization: Bearer <token> header.' },
      });
    }

    const token = match[1].trim();
    const tokenHash = hashToken(token);
    const user = findSession.get(tokenHash, Date.now());

    if (!user) {
      deleteSession.run(tokenHash);
      return res.status(401).json({
        error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Your token is invalid or has expired. Please log in again.' },
      });
    }

    req.user = { id: user.id, username: user.username };
    req.tokenHash = tokenHash;
    next();
  }

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Create an account.
  app.post('/api/auth/register', (req, res, next) => {
    try {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
        throw new ApiError(400, 'INVALID_USERNAME', 'Username must be 3–30 characters and may contain letters, numbers, dots, underscores, and hyphens.');
      }
      if (password.length < 8 || password.length > 200) {
        throw new ApiError(400, 'INVALID_PASSWORD', 'Password must contain between 8 and 200 characters.');
      }
      if (findUserByUsername.get(username)) {
        throw new ApiError(409, 'USERNAME_TAKEN', 'This username is already registered.');
      }

      const { salt, passwordHash } = makePasswordHash(password);
      const createdAt = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO users (username, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(username, salt, passwordHash, createdAt);

      const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error instanceof ApiError) return next(error);
      if (String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
        return next(new ApiError(409, 'USERNAME_TAKEN', 'This username is already registered.'));
      }
      next(error);
    }
  });

  // Log in and issue an opaque bearer token that expires after 24 hours.
  app.post('/api/auth/login', (req, res, next) => {
    try {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const user = findUserByUsername.get(username);

      if (!user || !passwordMatches(password, user.password_salt, user.password_hash)) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + SESSION_LIFETIME_MS;
      db.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(hashToken(token), user.id, expiresAt, new Date().toISOString());

      res.json({
        token,
        tokenType: 'Bearer',
        expiresAt: new Date(expiresAt).toISOString(),
        user: publicUser(user),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    deleteSession.run(req.tokenHash);
    res.json({ message: 'Logged out successfully.' });
  });

  // Browse products. Optional query parameters: q, category, inStock=true.
  app.get('/api/products', (req, res) => {
    const where = [];
    const parameters = [];

    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      where.push('(name LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)');
      const search = `%${req.query.q.trim()}%`;
      parameters.push(search, search);
    }
    if (typeof req.query.category === 'string' && req.query.category.trim()) {
      where.push('category = ? COLLATE NOCASE');
      parameters.push(req.query.category.trim());
    }
    if (req.query.inStock === 'true') where.push('stock > 0');

    const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
    const rows = db.prepare(sql).all(...parameters);
    res.json({ count: rows.length, products: rows.map(toProduct) });
  });

  app.get('/api/products/:id', (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return next(new ApiError(400, 'INVALID_PRODUCT_ID', 'Product ID must be a positive integer.'));
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!product) return next(new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product does not exist.'));
    res.json({ product: toProduct(product) });
  });

  // Prepared statements are reused for each order request.
  const getOrderByIdForUser = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?');
  const getOrderByKey = db.prepare('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?');
  const getProductById = db.prepare('SELECT * FROM products WHERE id = ?');
  const reduceStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      user_id, product_id, product_name, quantity, unit_price_cents,
      total_cents, currency, status, idempotency_key, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
  `);

  // This is the important flash-sale section. The entire operation is a single
  // SQLite IMMEDIATE transaction: check retry key, reserve stock, and create order.
  const createOrderTransaction = db.transaction((userId, idempotencyKey, requestHash, productId, quantity) => {
    // A retry with the same key must return the old order instead of charging stock again.
    const previousOrder = getOrderByKey.get(userId, idempotencyKey);
    if (previousOrder) {
      if (previousOrder.request_hash !== requestHash) {
        return { kind: 'KEY_REUSED_WITH_DIFFERENT_REQUEST' };
      }
      return { kind: 'REPLAY', order: previousOrder };
    }

    const product = getProductById.get(productId);
    if (!product) return { kind: 'PRODUCT_NOT_FOUND' };
    if (product.stock === 0) return { kind: 'SOLD_OUT' };
    if (product.stock < quantity) {
      return { kind: 'INSUFFICIENT_STOCK', available: product.stock };
    }

    // The WHERE stock >= quantity is a second safety check inside the transaction.
    const updateResult = reduceStock.run(quantity, productId, quantity);
    if (updateResult.changes !== 1) {
      // Normally prevented by the transaction, but never create an order if stock wasn't reserved.
      const latestProduct = getProductById.get(productId);
      if (!latestProduct || latestProduct.stock === 0) return { kind: 'SOLD_OUT' };
      return { kind: 'INSUFFICIENT_STOCK', available: latestProduct.stock };
    }

    const createdAt = new Date().toISOString();
    const orderResult = insertOrder.run(
      userId,
      product.id,
      product.name,
      quantity,
      product.price_cents,
      product.price_cents * quantity,
      product.currency,
      idempotencyKey,
      requestHash,
      createdAt,
    );

    return {
      kind: 'CREATED',
      order: getOrderByIdForUser.get(orderResult.lastInsertRowid, userId),
    };
  }).immediate();

  // Place an order. Clients must provide an Idempotency-Key for safe retries.
  app.post('/api/orders', requireAuth, (req, res, next) => {
    try {
      const idempotencyKey = req.get('Idempotency-Key')?.trim();
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key header between 8 and 200 characters (a UUID is recommended).');
      }

      const productId = Number(req.body?.productId);
      const quantity = Number(req.body?.quantity);
      if (!Number.isSafeInteger(productId) || productId < 1) {
        throw new ApiError(400, 'INVALID_PRODUCT_ID', 'productId must be a positive integer.');
      }
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) {
        throw new ApiError(400, 'INVALID_QUANTITY', `quantity must be an integer between 1 and ${MAX_ORDER_QUANTITY}.`);
      }

      // The key is bound to the request details. Reusing it for another product or quantity is rejected.
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ productId, quantity }))
        .digest('hex');

      const result = createOrderTransaction(
        req.user.id,
        idempotencyKey,
        requestHash,
        productId,
        quantity,
      );

      if (result.kind === 'KEY_REUSED_WITH_DIFFERENT_REQUEST') {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different order details. Use a new key for a new order.');
      }
      if (result.kind === 'PRODUCT_NOT_FOUND') {
        throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product does not exist.');
      }
      if (result.kind === 'SOLD_OUT') {
        throw new ApiError(409, 'SOLD_OUT', 'This product is sold out. No order was created.');
      }
      if (result.kind === 'INSUFFICIENT_STOCK') {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock. Only ${result.available} unit(s) remain. No order was created.`);
      }

      if (result.kind === 'REPLAY') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(200).json({
          message: 'This request was already processed. The original order is returned; stock was not reduced again.',
          order: toOrder(result.order, { idempotentReplay: true }),
        });
      }

      res.set('Idempotent-Replayed', 'false');
      return res.status(201).json({ message: 'Order placed successfully.', order: toOrder(result.order) });
    } catch (error) {
      next(error);
    }
  });

  // A user can only see their own orders.
  app.get('/api/orders', requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC
    `).all(req.user.id);
    res.json({ count: rows.length, orders: rows.map(row => toOrder(row)) });
  });

  app.get('/api/orders/:id', requireAuth, (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return next(new ApiError(400, 'INVALID_ORDER_ID', 'Order ID must be a positive integer.'));
    }
    const order = getOrderByIdForUser.get(id, req.user.id);
    if (!order) return next(new ApiError(404, 'ORDER_NOT_FOUND', 'Order does not exist.'));
    res.json({ order: toOrder(order) });
  });

  // Consistent JSON error responses for the API.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong on the server.' } });
  });

  return { app, db };
}

# Flash Sale API

A beginner-friendly backend API for a limited-time sale, built with **Node.js, Express, and SQLite**. It demonstrates how to keep stock safe when multiple customers try to buy the same product and how to make order requests safe to retry.

## Features

- Browse products and see the current stock.
- Search products and filter by category or availability.
- Register and log in with a username and password.
- Place an order for one or more units of a product.
- View your own order history and individual orders.
- Never decrement stock below zero.
- Return a clear `409 Conflict` response when a product is sold out or doesn't have enough units.
- Use an `Idempotency-Key` header so retrying the same order request doesn't create a second order.
- Store data in SQLite, with database constraints and a transaction around stock reservation and order creation.
- Include tests for retries, order privacy, and simultaneous purchase attempts.

## Requirements

- Node.js 20 or newer
- npm

## Run the API

```bash
git clone https://github.com/YOUR_USERNAME/flash-sale-api.git
cd flash-sale-api
npm install
npm start
```

The API starts at `http://localhost:3000`. It creates `flash-sale.sqlite` automatically and seeds five sample products on the first start.

For development with automatic restarts:

```bash
npm run dev
```

## Main routes

| Method | Endpoint | Auth required? | Purpose |
|---|---|---:|---|
| `GET` | `/api/health` | No | Check whether the API is running |
| `GET` | `/api/products` | No | List products and stock |
| `GET` | `/api/products/:id` | No | View one product and its stock |
| `POST` | `/api/auth/register` | No | Create an account |
| `POST` | `/api/auth/login` | No | Get a bearer token |
| `POST` | `/api/auth/logout` | Yes | Revoke the current token |
| `POST` | `/api/orders` | Yes | Place an order |
| `GET` | `/api/orders` | Yes | List the current user's orders |
| `GET` | `/api/orders/:id` | Yes | View one of the current user's orders |

Optional query parameters for `GET /api/products`:

- `q`: search the product name or description, e.g. `/api/products?q=keyboard`
- `category`: exact category match, e.g. `/api/products?category=Electronics`
- `inStock=true`: only show products where stock is greater than zero

## Try it with curl

### 1. Browse products

```bash
curl http://localhost:3000/api/products
```

Product prices are returned in both cents (`priceCents`) and display units (`price`). The integer cents value should be used for calculations to avoid floating-point currency errors.

### 2. Register a user

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo_user","password":"a-strong-demo-password"}'
```

Usernames must be 3–30 characters. Passwords must be 8–200 characters.

### 3. Log in and save the token

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo_user","password":"a-strong-demo-password"}'
```

Copy the `token` from the response. Tokens expire after 24 hours. Passwords are hashed with Node.js `scrypt`; only a hash of each session token is stored in the database.

### 4. Place an order

Replace `YOUR_TOKEN` with the token returned by login. Use a unique key for each new intended order; a UUID is a good choice.

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-order-0001' \
  -d '{"productId":1,"quantity":1}'
```

### 5. Retry the exact same request

Send the same request again, keeping the same `Idempotency-Key` and request body. The server returns the original order with HTTP `200`, and **does not reduce stock a second time**. A first successful order returns HTTP `201`.

The key is scoped to the authenticated user. Reusing the same key with a different product or quantity returns `409 IDEMPOTENCY_KEY_REUSED`. Use a new key for a new intended order.

### 6. View your orders

```bash
curl http://localhost:3000/api/orders \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

You can also inspect one order with `GET /api/orders/ORDER_ID`. Users can only access orders belonging to their account.

## How overselling is prevented

The order operation uses a single SQLite `IMMEDIATE` transaction. Inside that transaction the API:

1. Checks whether this user already used the idempotency key.
2. Checks that the product exists and has enough units.
3. Decreases stock with a guarded update: `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`.
4. Creates the order and records the idempotency key.

The stock reservation and order insertion are in the same transaction. If creating the order fails, SQLite rolls the stock update back. The `CHECK (stock >= 0)` database constraint is an additional safeguard. The transaction serializes competing writers, and the guarded update ensures the database never accepts a negative stock value.

**Why the idempotency key matters:** an HTTP client may time out after the server has already created an order. If the client retries with the same key, the API finds and returns the original order rather than charging stock again. Reusing the key with different request details is rejected.

## Error responses

Errors have a consistent JSON shape:

```json
{
  "error": {
    "code": "SOLD_OUT",
    "message": "This product is sold out. No order was created."
  }
}
```

Important statuses:

- `400 Bad Request`: invalid input or missing idempotency key
- `401 Unauthorized`: missing, invalid, or expired token
- `404 Not Found`: product or order doesn't exist (or the order belongs to another user)
- `409 Conflict`: sold out, not enough stock, duplicate username, or idempotency key reused with different details

## Run the tests

```bash
npm test
```

The tests check product browsing, idempotent retries, simultaneous attempts to purchase a limited-stock item, sold-out handling, and order privacy.

## Project structure

```text
flash-sale-api/
├── app.js              # API routes, authentication, and order logic
├── server.js           # Starts the HTTP server
├── test/
│   └── api.test.js     # Automated tests
├── requests.http       # Example requests for VS Code REST Client
├── package.json
├── .env.example
└── README.md
```

## Notes

- The seed products are sample data for development and testing.
- The database is local SQLite. This is suitable for a learning challenge and a single-machine deployment. A high-traffic production flash sale spread across multiple application servers should use a managed database and load testing appropriate to its infrastructure.
- Never commit real credentials or production secrets.

## License

Add a license file if you plan to distribute this project under a specific open-source license.

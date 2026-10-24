import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

const { app, db } = createApp({ dbPath: ':memory:' });
let server;
let baseUrl;

before(async () => {
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
});

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  return { response, data };
}

async function createUser(suffix) {
  const username = `tester_${suffix}`;
  const password = 'correct-horse-battery';
  const registration = await request('/api/auth/register', {
    method: 'POST', body: { username, password },
  });
  assert.equal(registration.response.status, 201);

  const login = await request('/api/auth/login', {
    method: 'POST', body: { username, password },
  });
  assert.equal(login.response.status, 200);
  return { token: login.data.token, user: login.data.user };
}

test('Flash Sale API: stock safety, idempotency, and order privacy', async t => {
  await t.test('browses products and exposes the available stock', async () => {
    const { response, data } = await request('/api/products');
    assert.equal(response.status, 200);
    assert.ok(data.products.length >= 1);
    assert.equal(typeof data.products[0].stock, 'number');
  });

  await t.test('a retry with the same idempotency key does not create another order', async () => {
    const user = await createUser('retry');
    const headers = { 'Idempotency-Key': 'retry-test-key-0001' };
    const body = { productId: 2, quantity: 1 };

    const first = await request('/api/orders', {
      method: 'POST', token: user.token, body, headers,
    });
    const second = await request('/api/orders', {
      method: 'POST', token: user.token, body, headers,
    });

    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 200);
    assert.equal(first.data.order.id, second.data.order.id);
    assert.equal(second.data.order.idempotentReplay, true);

    const changedPayload = await request('/api/orders', {
      method: 'POST', token: user.token,
      body: { productId: 2, quantity: 2 }, headers,
    });
    assert.equal(changedPayload.response.status, 409);
    assert.equal(changedPayload.data.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  await t.test('simultaneous orders never oversell a product', async () => {
    // Product 1 starts with exactly three units and is not used by the test above.
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => createUser(`race${i}`)));
    const attempts = users.map((user, i) => request('/api/orders', {
      method: 'POST',
      token: user.token,
      headers: { 'Idempotency-Key': `race-order-key-${String(i).padStart(4, '0')}` },
      body: { productId: 1, quantity: 1 },
    }));

    const results = await Promise.all(attempts);
    const successful = results.filter(result => result.response.status === 201);
    const rejected = results.filter(result => result.response.status === 409);
    assert.equal(successful.length, 3);
    assert.equal(rejected.length, 7);

    const product = await request('/api/products/1');
    assert.equal(product.data.product.stock, 0);
    assert.equal(product.data.product.inStock, false);

    const soldOutUser = await createUser('soldout');
    const soldOut = await request('/api/orders', {
      method: 'POST',
      token: soldOutUser.token,
      headers: { 'Idempotency-Key': 'sold-out-order-key-01' },
      body: { productId: 1, quantity: 1 },
    });
    assert.equal(soldOut.response.status, 409);
    assert.equal(soldOut.data.error.code, 'SOLD_OUT');
  });

  await t.test('users can see their own orders but not other users’ orders', async () => {
    const owner = await createUser('owner');
    const other = await createUser('other');
    const created = await request('/api/orders', {
      method: 'POST', token: owner.token,
      headers: { 'Idempotency-Key': 'private-order-key-0001' },
      body: { productId: 5, quantity: 1 },
    });
    assert.equal(created.response.status, 201);

    const ownList = await request('/api/orders', { token: owner.token });
    assert.ok(ownList.data.orders.some(order => order.id === created.data.order.id));

    const foreignOrder = await request(`/api/orders/${created.data.order.id}`, { token: other.token });
    assert.equal(foreignOrder.response.status, 404);
    assert.equal(foreignOrder.data.error.code, 'ORDER_NOT_FOUND');
  });
});

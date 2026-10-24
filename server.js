import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const { app, db } = createApp();

const server = app.listen(port, () => {
  console.log(`Flash Sale API is running at http://localhost:${port}`);
  console.log('Try GET /api/products to browse the seeded products.');
});

function shutDown(signal) {
  console.log(`\n${signal} received. Closing the API server...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutDown('SIGINT'));
process.on('SIGTERM', () => shutDown('SIGTERM'));

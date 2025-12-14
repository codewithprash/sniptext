import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth';
import { ocrRoutes } from './routes/ocr';
import { analyticsRoutes } from './routes/analytics';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  GEMINI_API_KEY: string;
  ADMIN_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS middleware
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));

// Request logging middleware
app.use('/*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${c.req.method} ${c.req.path} - ${c.res.status} (${ms}ms)`);
});

// ✅ Root endpoint - Redirect to landing page
app.get('/', (c) => {
  return c.redirect('https://sniptext.pages.dev/', 301);
});

// Health check (keep for monitoring)
app.get('/health', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT 1 as test').first();
    return c.json({
      status: 'healthy',
      database: result ? 'connected' : 'error',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      database: 'error',
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

// Mount routes
app.route('/api/auth', authRoutes);
app.route('/api', ocrRoutes);
app.route('/api', analyticsRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
  }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error('Global error:', err);
  return c.json({
    error: 'Internal Server Error',
    message: err.message,
  }, 500);
});

export default app;

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Import your route modules (we'll create these next)
import { authRoutes } from './routes/auth';
import { ocrRoutes } from './routes/ocr';

// Type definitions for your environment bindings
type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  GEMINI_API_KEY: string;
};

// Create Hono app with proper typing
const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for Chrome extension
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Root endpoint - API info
app.get('/', (c) => {
  return c.json({
    name: 'SnipText API',
    version: '1.0.0',
    endpoints: {
      auth_login: 'POST /api/auth/login',
      auth_verify_link: 'GET /api/auth/verify',
      auth_poll: 'GET /api/auth/poll',
      ocr: 'POST /api/ocr (requires auth)',
    },
    database: 'Connected to D1',
  });
});

// Health check endpoint
app.get('/health', async (c) => {
  try {
    // Test DB connection
    const result = await c.env.DB.prepare('SELECT 1 as test').first();
    return c.json({ 
      status: 'healthy',
      database: result ? 'connected' : 'error',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({ 
      status: 'unhealthy',
      error: 'Database connection failed'
    }, 500);
  }
});

// Mount route modules
app.route('/api/auth', authRoutes);
app.route('/api', ocrRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ 
    error: 'Endpoint not found',
    path: c.req.path,
    method: c.req.method
  }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ 
    error: 'Internal server error',
    message: err.message 
  }, 500);
});

// Export as default (required for Cloudflare Workers)
export default app;

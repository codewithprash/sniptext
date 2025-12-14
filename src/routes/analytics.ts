import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  ADMIN_KEY?: string;
};

export const analyticsRoutes = new Hono<{ Bindings: Bindings }>();

// POST /analytics/error
analyticsRoutes.post('/analytics/error', async (c) => {
  try {
    const errorData = await c.req.json();
    const userId = errorData.userId || 'anonymous';

    // Rate limit: 10 errors per minute
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    const recent = await c.env.DB
      .prepare('SELECT COUNT(*) as count FROM error_logs WHERE user_id = ? AND timestamp > ?')
      .bind(userId, oneMinAgo)
      .first<{ count: number }>();

    if (recent && recent.count >= 10) {
      return c.json({ success: false, error: 'Rate limit' }, 429);
    }

    await c.env.DB
      .prepare(`
        INSERT INTO error_logs (user_id, error_message, error_type, error_stack, error_code, context, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        userId,
        errorData.error?.message || 'Unknown',
        errorData.error?.type || 'UNKNOWN',
        errorData.error?.stack || null,
        errorData.error?.code || null,
        JSON.stringify(errorData.context || {}),
        errorData.timestamp || new Date().toISOString()
      )
      .run();

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false }, 500);
  }
});

// GET /analytics/errors (Admin only)
analyticsRoutes.get('/analytics/errors', async (c) => {
  const adminKey = c.req.query('key');
  
  if (!c.env.ADMIN_KEY || adminKey !== c.env.ADMIN_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const limit = parseInt(c.req.query('limit') || '50');
  const type = c.req.query('type');

  let query = 'SELECT * FROM error_logs';
  const params: any[] = [];

  if (type) {
    query += ' WHERE error_type = ?';
    params.push(type);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const errors = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({
    success: true,
    count: errors.results?.length || 0,
    errors: errors.results,
  });
});

// GET /analytics/stats (Admin only)
analyticsRoutes.get('/analytics/stats', async (c) => {
  const adminKey = c.req.query('key');
  
  if (!c.env.ADMIN_KEY || adminKey !== c.env.ADMIN_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '7');
  const since = new Date();
  since.setDate(since.getDate() - days);

  const byType = await c.env.DB
    .prepare(`
      SELECT error_type, COUNT(*) as count
      FROM error_logs
      WHERE timestamp >= ?
      GROUP BY error_type
      ORDER BY count DESC
    `)
    .bind(since.toISOString())
    .all();

  const total = await c.env.DB
    .prepare('SELECT COUNT(*) as count FROM error_logs WHERE timestamp >= ?')
    .bind(since.toISOString())
    .first<{ count: number }>();

  return c.json({
    success: true,
    period: `${days} days`,
    total: total?.count || 0,
    byType: byType.results,
  });
});

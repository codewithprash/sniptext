import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

export const authRoutes = new Hono<{ Bindings: Bindings }>();

// POST /api/auth/login - Request magic link
authRoutes.post('/login', async (c) => {
  try {
    const { email } = await c.req.json();

    // Validate email
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Invalid email address' }, 400);
    }

    // Generate session credentials
    const sessionId = crypto.randomUUID();
    const verifyToken = crypto.randomUUID();

    // Find or create user
    let user = await c.env.DB
      .prepare('SELECT id, email, plan FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; email: string; plan: string }>();

    if (!user) {
      // Create new user with free plan
      const userId = crypto.randomUUID();
      await c.env.DB
        .prepare(
          'INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(userId, email, 'free', new Date().toISOString())
        .run();

      user = { id: userId, email, plan: 'free' };
    }

    // Store pending auth session (expires in 10 minutes)
    await c.env.DB
      .prepare(
        `INSERT INTO auth_sessions (session_id, user_id, verify_token, expires_at, verified)
         VALUES (?, ?, ?, datetime('now', '+10 minutes'), 0)`
      )
      .bind(sessionId, user.id, verifyToken)
      .run();

    // Generate magic link (in production, send via email service)
    const baseUrl = new URL(c.req.url).origin;
    const magicLink = `${baseUrl}/api/auth/verify?token=${verifyToken}&session=${sessionId}`;

    // TODO: Send email with magicLink using service like Resend, SendGrid, etc.
    console.log('Magic link for', email, ':', magicLink);

    return c.json({
      success: true,
      sessionId,
      message: 'Check your email for the login link',
      // REMOVE IN PRODUCTION:
      _dev_magic_link: magicLink
    });

  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Login failed' }, 500);
  }
});

// GET /api/auth/verify - User clicks magic link
authRoutes.get('/verify', async (c) => {
  const token = c.req.query('token');
  const sessionId = c.req.query('session');

  if (!token || !sessionId) {
    return c.html(`
      <html>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>❌ Invalid authentication link</h1>
          <p>Please request a new login link from the extension.</p>
        </body>
      </html>
    `);
  }

  try {
    // Verify session exists and is valid
    const session = await c.env.DB
      .prepare(
        `SELECT user_id, verified, expires_at 
         FROM auth_sessions 
         WHERE session_id = ? AND verify_token = ?`
      )
      .bind(sessionId, token)
      .first<{ user_id: string; verified: number; expires_at: string }>();

    if (!session) {
      return c.html(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>❌ Invalid link</h1>
            <p>This authentication link is not valid.</p>
          </body>
        </html>
      `);
    }

    // Check if expired
    if (new Date(session.expires_at) < new Date()) {
      return c.html(`
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>⏰ Link expired</h1>
            <p>This authentication link has expired. Please request a new one.</p>
          </body>
        </html>
      `);
    }

    // Mark session as verified
    await c.env.DB
      .prepare('UPDATE auth_sessions SET verified = 1 WHERE session_id = ?')
      .bind(sessionId)
      .run();

    return c.html(`
      <html>
        <head>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              text-align: center;
              padding: 50px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
            }
            .card {
              background: white;
              color: #333;
              max-width: 500px;
              margin: 50px auto;
              padding: 40px;
              border-radius: 20px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            h1 { margin: 0 0 20px 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✅ Authentication Successful!</h1>
            <p>You can now close this window and return to the SnipText extension.</p>
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
              The extension should automatically detect your login.
            </p>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Verify error:', error);
    return c.html(`
      <html>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>❌ Verification failed</h1>
          <p>An error occurred. Please try again.</p>
        </body>
      </html>
    `);
  }
});

// GET /api/auth/poll - Extension polls for JWT after user clicks link
authRoutes.get('/poll', async (c) => {
  const sessionId = c.req.query('sessionId');

  if (!sessionId) {
    return c.json({ error: 'Missing sessionId parameter' }, 400);
  }

  try {
    // Check session status
    const session = await c.env.DB
      .prepare(
        `SELECT s.user_id, s.verified, u.email, u.plan
         FROM auth_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.session_id = ? AND s.expires_at > datetime('now')`
      )
      .bind(sessionId)
      .first<{ user_id: string; verified: number; email: string; plan: string }>();

    if (!session) {
      return c.json({ 
        authenticated: false, 
        error: 'Invalid or expired session' 
      });
    }

    // Still waiting for user to click magic link
    if (session.verified === 0) {
      return c.json({ 
        authenticated: false, 
        status: 'pending',
        message: 'Waiting for email verification' 
      });
    }

    // Session verified! Generate JWT token
    const payload = {
      sub: session.user_id,
      email: session.email,
      plan: session.plan,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7) // 7 days
    };

    // Simple JWT (in production use proper JWT library like jose or @tsndr/cloudflare-worker-jwt)
    const token = btoa(JSON.stringify(payload));

    // Clean up used session
    await c.env.DB
      .prepare('DELETE FROM auth_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();

    return c.json({
      authenticated: true,
      token,
      user: {
        id: session.user_id,
        email: session.email,
        plan: session.plan
      }
    });

  } catch (error) {
    console.error('Poll error:', error);
    return c.json({ error: 'Authentication check failed' }, 500);
  }
});

// GET /api/auth/me - Get current user info (requires auth)
authRoutes.get('/me', async (c) => {
  // TODO: Add JWT middleware
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));

    const user = await c.env.DB
      .prepare('SELECT id, email, plan, created_at FROM users WHERE id = ?')
      .bind(payload.sub)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ user });
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401);
  }
});

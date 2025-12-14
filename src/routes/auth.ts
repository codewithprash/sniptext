import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

interface GoogleTokenInfo {
  email: string;
  email_verified: string;
  azp: string;
  exp: string;
  aud?: string;
}

export const authRoutes = new Hono<{ Bindings: Bindings }>();

// POST /auth/google - Google OAuth login
authRoutes.post('/google', async (c) => {
  try {
    const { googleToken, email, name, picture } = await c.req.json();

    if (!email) {
      return c.json({ error: 'Missing email' }, 400);
    }

    // Verify Google token
    if (googleToken) {
      try {
        const verifyResponse = await fetch(
          `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${googleToken}`
        );

        if (!verifyResponse.ok) {
          return c.json({ error: 'Invalid Google token' }, 401);
        }

        const tokenInfo = await verifyResponse.json() as GoogleTokenInfo;
        
        if (tokenInfo.email !== email) {
          return c.json({ error: 'Email mismatch' }, 401);
        }
      } catch (verifyError) {
        console.error('Token verification error:', verifyError);
        return c.json({ error: 'Token verification failed' }, 401);
      }
    }

    // Find or create user
    let user = await c.env.DB
      .prepare('SELECT id, email, plan, name, picture FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; email: string; plan: string; name: string | null; picture: string | null }>();

    if (!user) {
      const userId = crypto.randomUUID();
      await c.env.DB
        .prepare('INSERT INTO users (id, email, name, picture, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, email, name || null, picture || null, 'free', new Date().toISOString())
        .run();
      user = { id: userId, email, plan: 'free', name: name || null, picture: picture || null };
    } else if (name || picture) {
      // Update name/picture if provided
      await c.env.DB
        .prepare('UPDATE users SET name = ?, picture = ?, updated_at = ? WHERE id = ?')
        .bind(name || user.name, picture || user.picture, new Date().toISOString(), user.id)
        .run();
    }

    // Generate secure JWT
    const payload = {
      sub: user.id,
      email: user.email,
      plan: user.plan,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30), // 30 days
    };

    const token = await sign(payload, c.env.JWT_SECRET);

    return c.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        plan: user.plan,
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    return c.json({
      error: 'Authentication failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

// GET /auth/me - Get current user
authRoutes.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = await verify(token, c.env.JWT_SECRET) as {
      sub: string;
      email: string;
      plan: string;
    };

    const user = await c.env.DB
      .prepare('SELECT id, email, name, picture, plan, created_at FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<{ 
        id: string; 
        email: string; 
        name: string | null;
        picture: string | null;
        plan: string; 
        created_at: string 
      }>();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        plan: user.plan,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error('Token verification failed:', error);
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// POST /auth/refresh - Refresh token
authRoutes.post('/refresh', async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = await verify(token, c.env.JWT_SECRET) as { sub: string };

    const user = await c.env.DB
      .prepare('SELECT id, email, plan FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<{ id: string; email: string; plan: string }>();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const newPayload = {
      sub: user.id,
      email: user.email,
      plan: user.plan,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30),
    };

    const newToken = await sign(newPayload, c.env.JWT_SECRET);

    return c.json({
      success: true,
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
      },
    });
  } catch (error) {
    console.error('Refresh error:', error);
    return c.json({ error: 'Token refresh failed' }, 500);
  }
});

// DELETE /auth/logout
authRoutes.delete('/logout', (c) => {
  return c.json({
    success: true,
    message: 'Logged out successfully',
  });
});

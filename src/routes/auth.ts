import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

// Type definition for Google token info
interface GoogleTokenInfo {
  email: string;
  email_verified: string;
  azp: string;
  exp: string;
  aud?: string;
}

export const authRoutes = new Hono<{ Bindings: Bindings }>();

// POST /api/auth/google - Google OAuth authentication
authRoutes.post('/google', async (c) => {
  try {
    const { googleToken, email, name, picture } = await c.req.json();

    console.log('Google auth request for:', email);

    if (!email) {
      return c.json({ error: 'Missing email' }, 400);
    }

    // Optional: Verify Google token with Google's API (recommended for production)
    if (googleToken) {
      try {
        const verifyResponse = await fetch(
          `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${googleToken}`
        );

        if (!verifyResponse.ok) {
          console.error('Google token verification failed');
          return c.json({ error: 'Invalid Google token' }, 401);
        }

        const tokenInfo = await verifyResponse.json() as GoogleTokenInfo;
        console.log('Google token verified:', tokenInfo.email);

        // Ensure the email matches
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
      .prepare('SELECT id, email, plan FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; email: string; plan: string }>();

    if (!user) {
      // Create new user with free plan
      const userId = crypto.randomUUID();
      console.log('Creating new user:', userId, email);

      await c.env.DB
        .prepare(
          'INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(userId, email, 'free', new Date().toISOString())
        .run();

      user = { id: userId, email, plan: 'free' };
    } else {
      console.log('Existing user found:', user.id);
    }

    // Generate JWT token
    const payload = {
      sub: user.id,
      email: user.email,
      plan: user.plan,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30) // 30 days
    };

    const token = btoa(JSON.stringify(payload));

    console.log('Authentication successful for:', email);

    return c.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan
      }
    });

  } catch (error) {
    console.error('Google auth error:', error);
    return c.json({ 
      error: 'Authentication failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// GET /api/auth/me - Get current user info (requires auth)
authRoutes.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token)) as {
      sub: string;
      email: string;
      plan: string;
      exp: number;
    };

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ error: 'Token expired' }, 401);
    }

    const user = await c.env.DB
      .prepare('SELECT id, email, plan, created_at FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<{ id: string; email: string; plan: string; created_at: string }>();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ 
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    return c.json({ error: 'Invalid token' }, 401);
  }
});

// POST /api/auth/refresh - Refresh token
authRoutes.post('/refresh', async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token)) as {
      sub: string;
      email: string;
      plan: string;
    };

    // Get latest user data
    const user = await c.env.DB
      .prepare('SELECT id, email, plan FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<{ id: string; email: string; plan: string }>();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Generate new token
    const newPayload = {
      sub: user.id,
      email: user.email,
      plan: user.plan,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30)
    };

    const newToken = btoa(JSON.stringify(newPayload));

    return c.json({
      success: true,
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan
      }
    });

  } catch (error) {
    console.error('Refresh token error:', error);
    return c.json({ error: 'Token refresh failed' }, 500);
  }
});

// DELETE /api/auth/logout - Logout (revoke token)
authRoutes.delete('/logout', async (c) => {
  // With JWT, logout is handled client-side by deleting the token
  // You could implement a token blacklist in D1 if needed
  
  return c.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// GET /api/auth/status - Check auth status
authRoutes.get('/status', async (c) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ 
      authenticated: false,
      message: 'No auth token provided'
    });
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token)) as {
      sub: string;
      exp: number;
    };

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ 
        authenticated: false,
        message: 'Token expired'
      });
    }

    const user = await c.env.DB
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(payload.sub)
      .first();

    return c.json({
      authenticated: !!user,
      message: user ? 'Valid token' : 'User not found'
    });

  } catch (error) {
    return c.json({ 
      authenticated: false,
      message: 'Invalid token'
    });
  }
});

// DEBUG endpoint - Get all users (REMOVE IN PRODUCTION)
authRoutes.get('/debug/users', async (c) => {
  const users = await c.env.DB
    .prepare('SELECT id, email, plan, created_at FROM users ORDER BY created_at DESC LIMIT 10')
    .all();
  
  return c.json({
    users: users.results,
    count: users.results?.length || 0
  });
});

// DEBUG endpoint - Check database connection (REMOVE IN PRODUCTION)
authRoutes.get('/debug/db', async (c) => {
  try {
    const result = await c.env.DB
      .prepare('SELECT COUNT(*) as count FROM users')
      .first<{ count: number }>();
    
    return c.json({
      status: 'connected',
      totalUsers: result?.count || 0
    });
  } catch (error) {
    return c.json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  GEMINI_API_KEY: string;
};

type Variables = {
  userId: string;
  userPlan: string;
  userEmail: string;
};

export const ocrRoutes = new Hono<{ 
  Bindings: Bindings; 
  Variables: Variables 
}>();

// Auth middleware - verify JWT token
ocrRoutes.use('/ocr', async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ error: 'Token expired' }, 401);
    }

    // Store user info in context
    c.set('userId', payload.sub);
    c.set('userPlan', payload.plan);
    c.set('userEmail', payload.email);

    await next();
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401);
  }
});

// POST /api/ocr - Main OCR endpoint
ocrRoutes.post('/ocr', async (c) => {
  const userId = c.get('userId');
  const userPlan = c.get('userPlan');

  try {
    // Get request body
    const { imageBase64 } = await c.req.json();

    if (!imageBase64) {
      return c.json({ error: 'Missing imageBase64 field' }, 400);
    }

    // Check daily usage limits
    const today = new Date().toISOString().slice(0, 10);
    const usage = await c.env.DB
      .prepare('SELECT count FROM usage_daily WHERE user_id = ? AND date = ?')
      .bind(userId, today)
      .first<{ count: number }>();

    const limits: Record<string, number> = {
      free: 20,
      pro: 1000,
      'pro-plus': 5000,
      enterprise: 999999
    };
    const limit = limits[userPlan] || 20;
    const used = usage?.count || 0;

    if (used >= limit) {
      return c.json({
        error: 'Daily limit exceeded',
        limit,
        used,
        plan: userPlan,
        message: 'Upgrade your plan to continue using SnipText OCR'
      }, 429);
    }

    // Call Gemini API for OCR
    const extractedText = await callGeminiOCR(imageBase64, c.env.GEMINI_API_KEY);

    // Update usage counter
    if (usage) {
      await c.env.DB
        .prepare('UPDATE usage_daily SET count = count + 1 WHERE user_id = ? AND date = ?')
        .bind(userId, today)
        .run();
    } else {
      await c.env.DB
        .prepare('INSERT INTO usage_daily (user_id, date, count) VALUES (?, ?, 1)')
        .bind(userId, today)
        .run();
    }

    return c.json({
      success: true,
      text: extractedText,
      usage: {
        used: used + 1,
        limit,
        remaining: limit - used - 1,
        plan: userPlan
      }
    });

  } catch (error: any) {
    console.error('OCR processing error:', error);
    return c.json({ 
      error: 'OCR processing failed',
      message: error.message 
    }, 500);
  }
});

// GET /api/ocr/usage - Check current usage
ocrRoutes.get('/usage', async (c) => {
  const userId = c.get('userId');
  const userPlan = c.get('userPlan');

  const today = new Date().toISOString().slice(0, 10);
  const usage = await c.env.DB
    .prepare('SELECT count FROM usage_daily WHERE user_id = ? AND date = ?')
    .bind(userId, today)
    .first<{ count: number }>();

  const limits: Record<string, number> = {
    free: 20,
    pro: 1000,
    'pro-plus': 5000,
    enterprise: 999999
  };
  const limit = limits[userPlan] || 20;
  const used = usage?.count || 0;

  return c.json({
    plan: userPlan,
    used,
    limit,
    remaining: limit - used,
    date: today
  });
});

// Helper function: Call Gemini API
async function callGeminiOCR(imageBase64: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: 'image/png',
              data: imageBase64
            }
          },
          {
            text: `Extract ALL text from this image with EXACT formatting preservation.

CRITICAL REQUIREMENTS:
1. Maintain original line breaks, spacing, and indentation exactly as shown
2. Preserve column alignment and table structures
3. Keep bullet points, numbering, and hierarchies
4. Detect and preserve multi-column layouts (read left-to-right, top-to-bottom)
5. Maintain paragraph breaks and vertical spacing between sections
6. Preserve mathematical formulas, special characters, and symbols
7. Support ALL languages (English, Hindi, code, etc.)
8. Keep code formatting if present (indentation, syntax)

OUTPUT FORMAT:
- Return ONLY the extracted text with preserved formatting
- Use spaces/tabs to maintain horizontal alignment
- Use line breaks exactly as they appear in the image
- Use blank lines to preserve vertical spacing between sections
- DO NOT add explanations, descriptions, or markdown formatting
- DO NOT translate, modify, or interpret the text
- DO NOT add "Here is the text:" or any prefix/suffix

Extract the text now:`
          }
        ]
      }],
      generationConfig: {
        temperature: 0,
        topP: 0.95,
        topK: 20,
        maxOutputTokens: 8192
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!text || text.trim().length === 0) {
    throw new Error('No text extracted from image');
  }

  return text.trim();
}

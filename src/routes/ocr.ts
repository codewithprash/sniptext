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

// Auth middleware - verify JWT token for ALL /ocr routes
ocrRoutes.use('/ocr/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');

  console.log('Auth middleware triggered, header:', authHeader ? 'present' : 'missing');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token)) as {
      sub: string;
      email: string;
      plan: string;
      exp: number;
    };

    console.log('Token payload:', { userId: payload.sub, plan: payload.plan });

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.error('Token expired');
      return c.json({ error: 'Token expired' }, 401);
    }

    // Store user info in context
    c.set('userId', payload.sub);
    c.set('userPlan', payload.plan);
    c.set('userEmail', payload.email);

    await next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return c.json({ error: 'Invalid token' }, 401);
  }
});

// POST /api/ocr - Main OCR endpoint
ocrRoutes.post('/ocr', async (c) => {
  const userId = c.get('userId');
  const userPlan = c.get('userPlan');

  console.log(`OCR request from user: ${userId}, plan: ${userPlan}`);

  try {
    const body = await c.req.json();
    const { imageBase64 } = body;

    if (!imageBase64) {
      console.error('Missing imageBase64 in request');
      return c.json({ 
        success: false,
        error: 'Missing imageBase64 field' 
      }, 400);
    }

    console.log(`Image data length: ${imageBase64.length} characters`);

    if (!c.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY not configured');
      return c.json({
        success: false,
        error: 'OCR service not configured. Please contact support.'
      }, 500);
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

    console.log(`Usage check: ${used}/${limit} for plan ${userPlan}`);

    if (used >= limit) {
      return c.json({
        success: false,
        error: 'Daily limit exceeded',
        limit,
        used,
        plan: userPlan,
        message: 'Upgrade your plan to continue using SnipText OCR'
      }, 429);
    }

    console.log('Calling Gemini API...');
    const extractedText = await callGeminiOCR(imageBase64, c.env.GEMINI_API_KEY);
    console.log(`OCR successful, extracted ${extractedText.length} characters`);

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

    console.log(`Usage updated: ${used + 1}/${limit}`);

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
    console.error('Error stack:', error.stack);
    
    return c.json({ 
      success: false,
      error: 'OCR processing failed',
      message: error.message || 'Unknown error occurred',
      details: error.toString()
    }, 500);
  }
});

// GET /api/ocr/usage - Check current usage
ocrRoutes.get('/ocr/usage', async (c) => {
  const userId = c.get('userId');
  const userPlan = c.get('userPlan');

  console.log(`Usage check for user: ${userId}, plan: ${userPlan}`);

  try {
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

    console.log(`Usage stats: ${used}/${limit}, remaining: ${limit - used}`);

    return c.json({
      plan: userPlan,
      used,
      limit,
      remaining: limit - used,
      date: today
    });
  } catch (error) {
    console.error('Usage check error:', error);
    return c.json({
      error: 'Failed to fetch usage',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Helper function: Call Gemini API (exact match to offline code)
async function callGeminiOCR(imageBase64: string, apiKey: string): Promise<string> {
  if (!apiKey) {
    throw new Error("Missing API key");
  }

  const model = "gemini-flash-lite-latest";
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  console.log("[SnipText OCR] Using model:", model);

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "image/png",
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
7. Support ALL languages (English, Hindi, etc.)
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
      }
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.95,
      topK: 20,
      maxOutputTokens: 8192
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `API Error ${response.status}`;
    
    try {
      const errorData = JSON.parse(errorText);
      if (errorData.error?.message) {
        errorMsg = errorData.error.message;
      }
    } catch (e) {
      errorMsg = errorText;
    }
    
    console.error('Gemini API error:', errorMsg);
    throw new Error(errorMsg);
  }

  const data = await response.json();
  return extractTextFromGeminiResponse(data);
}

// Extract text from Gemini response
function extractTextFromGeminiResponse(data: any): string {
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error("No text extracted from image");
  }

  const text = candidate.content.parts
    .map((part: any) => part.text || "")
    .join("")
    .trim();

  if (!text || text.length === 0) {
    throw new Error("No text extracted from image");
  }

  console.log(`OCR successful, extracted ${text.length} characters`);
  return text;
}

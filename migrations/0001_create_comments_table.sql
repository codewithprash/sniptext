-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'pro-plus', 'enterprise')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Auth sessions (for magic link flow)
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Usage tracking
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','trial','expired','canceled')),
  plan_code TEXT NOT NULL,
  started_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  canceled_at DATETIME,
  external_ref TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(verify_token);
CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON usage_daily(date);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

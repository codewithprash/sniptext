-- Drop existing tables
DROP TABLE IF EXISTS error_logs;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS usage_daily;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS users;

-- Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  picture TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'pro-plus', 'enterprise')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_plan ON users(plan);

-- Auth sessions
CREATE TABLE auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_token ON auth_sessions(verify_token);

-- Usage tracking
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_usage_daily_date ON usage_daily(date);

-- Subscriptions
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','trial','expired','canceled')),
  plan_code TEXT NOT NULL,
  started_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  canceled_at DATETIME,
  external_ref TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

-- Error logs
CREATE TABLE error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_stack TEXT,
  error_code INTEGER,
  context TEXT,
  timestamp TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_error_user ON error_logs(user_id);
CREATE INDEX idx_error_type ON error_logs(error_type);
CREATE INDEX idx_error_timestamp ON error_logs(timestamp);

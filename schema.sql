CREATE TABLE IF NOT EXISTS ads_config (
  id SERIAL PRIMARY KEY,
  owner_email VARCHAR(255) DEFAULT 'tarcisioraduntz@gmail.com',
  meta_system_user_token TEXT,
  meta_business_manager_id VARCHAR(50),
  google_access_token TEXT,
  google_refresh_token TEXT,
  google_token_expires_at TIMESTAMP,
  google_mcc_customer_id VARCHAR(20),
  meta_connected BOOLEAN DEFAULT FALSE,
  google_connected BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT NOW()
);
INSERT INTO ads_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ads_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name VARCHAR(255) NOT NULL,
  client_segment VARCHAR(100),
  client_color VARCHAR(7),
  client_initials VARCHAR(3),
  meta_ad_account_id VARCHAR(50),
  google_customer_id VARCHAR(20),
  bac_ressonancia DECIMAL(3,1) DEFAULT 0,
  bac_fluxo DECIMAL(3,1) DEFAULT 0,
  bac_homeostase DECIMAL(3,1) DEFAULT 0,
  monthly_budget_target DECIMAL(10,2),
  cpl_benchmark DECIMAL(10,2),
  status VARCHAR(20) DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ads_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES ads_accounts(id) ON DELETE CASCADE,
  platform VARCHAR(10) NOT NULL CHECK (platform IN ('meta','google')),
  platform_campaign_id VARCHAR(100) NOT NULL,
  name VARCHAR(500),
  objective VARCHAR(100),
  status VARCHAR(50),
  effective_status VARCHAR(50),
  daily_budget DECIMAL(10,2),
  lifetime_budget DECIMAL(10,2),
  start_date DATE,
  end_date DATE,
  last_synced_at TIMESTAMP,
  sync_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(platform, platform_campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_account ON ads_campaigns(account_id);
CREATE TABLE IF NOT EXISTS ads_adsets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES ads_campaigns(id) ON DELETE CASCADE,
  platform_adset_id VARCHAR(100) NOT NULL,
  name VARCHAR(500),
  status VARCHAR(50),
  targeting_summary JSONB DEFAULT '{}',
  daily_budget DECIMAL(10,2),
  bid_amount DECIMAL(10,2),
  last_synced_at TIMESTAMP,
  UNIQUE(campaign_id, platform_adset_id)
);
CREATE TABLE IF NOT EXISTS ads_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES ads_campaigns(id) ON DELETE CASCADE,
  account_id UUID REFERENCES ads_accounts(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  platform VARCHAR(10) NOT NULL,
  impressions BIGINT DEFAULT 0,
  reach BIGINT DEFAULT 0,
  frequency DECIMAL(5,2),
  clicks INT DEFAULT 0,
  ctr DECIMAL(8,5),
  spend DECIMAL(10,2) DEFAULT 0,
  cpc DECIMAL(10,2),
  cpm DECIMAL(10,2),
  leads INT DEFAULT 0,
  conversions INT DEFAULT 0,
  cpl DECIMAL(10,2),
  cpa DECIMAL(10,2),
  raw_data JSONB,
  UNIQUE(campaign_id, date)
);
CREATE INDEX IF NOT EXISTS idx_metrics_campaign_date ON ads_metrics(campaign_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_account_date ON ads_metrics(account_id, date DESC);
CREATE TABLE IF NOT EXISTS ads_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES ads_accounts(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES ads_campaigns(id),
  type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) DEFAULT 'warning',
  message TEXT NOT NULL,
  metric_value DECIMAL(10,2),
  metric_threshold DECIMAL(10,2),
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON ads_alerts(resolved, created_at DESC) WHERE resolved = FALSE;
CREATE TABLE IF NOT EXISTS ads_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES ads_accounts(id),
  platform VARCHAR(10),
  trigger_type VARCHAR(20) DEFAULT 'cron',
  status VARCHAR(20) NOT NULL,
  campaigns_synced INT DEFAULT 0,
  metrics_synced INT DEFAULT 0,
  error_message TEXT,
  duration_ms INT,
  synced_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ads_ai_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES ads_accounts(id),
  messages JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

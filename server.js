require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const oauth = require('./services/oauth');
const metaSvc = require('./services/meta');
const googleSvc = require('./services/google');
const alertsSvc = require('./services/alerts');

const app = express();
const PORT = process.env.ADS_PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json());
app.use(express.static('public'));

const auth = async (req, res, next) => {
  req.userId = 'dev';
  return next();
};

async function getConfig() {
  const { rows: [cfg] } = await pool.query('SELECT * FROM ads_config WHERE id=1');
  return cfg;
}

app.get('/api/setup/status', auth, async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json({
      meta: { connected: cfg?.meta_connected||false, business_id: cfg?.meta_business_manager_id, token_set: !!cfg?.meta_system_user_token },
      google: { connected: cfg?.google_connected||false, mcc_id: cfg?.google_mcc_customer_id, token_set: !!cfg?.google_refresh_token }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/setup/meta', auth, async (req, res) => {
  const { system_user_token, business_manager_id } = req.body;
  if (!system_user_token) return res.status(400).json({ error: 'Token obrigatorio' });
  try {
    const validation = await oauth.validateMetaToken(system_user_token);
    if (!validation.valid) return res.status(400).json({ error: 'Token invalido: ' + validation.error });
    await pool.query('UPDATE ads_config SET meta_system_user_token=$1, meta_business_manager_id=$2, meta_connected=TRUE, updated_at=NOW() WHERE id=1', [system_user_token, business_manager_id]);
    res.json({ success: true, user: validation.user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/setup/google/auth-url', auth, (req, res) => {
  const redirectUri = `${process.env.APP_URL}/api/setup/google/callback`;
  const url = oauth.buildGoogleAuthUrl(process.env.GOOGLE_CLIENT_ID, redirectUri);
  res.json({ url });
});

app.get('/api/setup/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?setup_error=' + error);
  try {
    const redirectUri = `${process.env.APP_URL}/api/setup/google/callback`;
    const tokens = await oauth.exchangeGoogleCode(code, process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await pool.query('UPDATE ads_config SET google_access_token=$1, google_refresh_token=$2, google_token_expires_at=$3, google_mcc_customer_id=$4, google_connected=TRUE, updated_at=NOW() WHERE id=1',
      [tokens.access_token, tokens.refresh_token, expiresAt, process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID||null]);
    res.redirect('/?setup_success=google');
  } catch (e) { res.redirect('/?setup_error=' + encodeURIComponent(e.message)); }
});

app.get('/api/setup/meta/accounts', auth, async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg?.meta_system_user_token) return res.status(400).json({ error: 'Meta nao configurado' });
    const owned = await oauth.getMetaAdAccounts(cfg.meta_business_manager_id, cfg.meta_system_user_token);
    const clients = await oauth.getMetaClientAdAccounts(cfg.meta_business_manager_id, cfg.meta_system_user_token);
    res.json({ owned, clients, total: owned.length + clients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/accounts', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*,
        (SELECT COUNT(*) FROM ads_campaigns c WHERE c.account_id=a.id AND c.status='ACTIVE') as active_campaigns,
        (SELECT COUNT(*) FROM ads_alerts al WHERE al.account_id=a.id AND al.resolved=FALSE) as open_alerts,
        COALESCE(kpis.month_spend,0) as month_spend,
        kpis.month_leads, kpis.month_cpl, kpis.budget_pct_used
      FROM ads_accounts a
      LEFT JOIN ads_account_kpis kpis ON kpis.account_id=a.id
      WHERE a.status != 'archived' ORDER BY a.client_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts', auth, async (req, res) => {
  const { client_name, client_segment, client_color, client_initials, meta_ad_account_id, google_customer_id, monthly_budget_target, cpl_benchmark, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ads_accounts (client_name,client_segment,client_color,client_initials,meta_ad_account_id,google_customer_id,monthly_budget_target,cpl_benchmark,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [client_name, client_segment, client_color, client_initials, meta_ad_account_id?.replace('act_',''), google_customer_id?.replace(/-/g,''), monthly_budget_target, cpl_benchmark, notes]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/accounts/:id', auth, async (req, res) => {
  const fields = ['client_name','client_segment','client_color','monthly_budget_target','cpl_benchmark','notes','bac_ressonancia','bac_fluxo','bac_homeostase'];
  const updates = []; const values = [];
  for (const f of fields) { if (req.body[f]!==undefined) { updates.push(`${f}=$${updates.length+1}`); values.push(req.body[f]); } }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  values.push(req.params.id);
  try {
    await pool.query(`UPDATE ads_accounts SET ${updates.join(',')},updated_at=NOW() WHERE id=$${values.length}`, values);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/campaigns', auth, async (req, res) => {
  const { account, platform, status } = req.query;
  let query = `SELECT c.*, a.client_name, a.client_color, a.client_initials, a.client_segment,
    (SELECT json_agg(row_to_json(m) ORDER BY m.date DESC) FROM
     (SELECT date,spend,leads,cpl,impressions,clicks,ctr FROM ads_metrics m2 WHERE m2.campaign_id=c.id ORDER BY date DESC LIMIT 14) m) as recent_metrics
    FROM ads_campaigns c JOIN ads_accounts a ON a.id=c.account_id WHERE 1=1`;
  const params = [];
  if (account)  { params.push(account);  query += ` AND c.account_id=$${params.length}`; }
  if (platform) { params.push(platform); query += ` AND c.platform=$${params.length}`; }
  if (status)   { params.push(status);   query += ` AND c.status=$${params.length}`; }
  query += ' ORDER BY c.status DESC, a.client_name, c.name';
  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/campaigns/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE','PAUSED'].includes(status)) return res.status(400).json({ error: 'Status invalido' });
  try {
    const { rows:[camp] } = await pool.query('SELECT c.*, a.meta_ad_account_id, a.google_customer_id FROM ads_campaigns c JOIN ads_accounts a ON a.id=c.account_id WHERE c.id=$1', [req.params.id]);
    if (!camp) return res.status(404).json({ error: 'Campanha nao encontrada' });
    const cfg = await getConfig();
    if (camp.platform==='meta') {
      await metaSvc.updateCampaignStatus(camp.platform_campaign_id, status, cfg);
    } else {
      const accessToken = await oauth.getValidGoogleToken(pool);
      await googleSvc.updateCampaignStatus(camp.google_customer_id, camp.platform_campaign_id, status, accessToken);
    }
    await pool.query('UPDATE ads_campaigns SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/campaigns/:id/budget', auth, async (req, res) => {
  const { daily_budget } = req.body;
  if (!daily_budget || daily_budget<1) return res.status(400).json({ error: 'Budget invalido' });
  try {
    const { rows:[camp] } = await pool.query('SELECT c.*, a.meta_ad_account_id FROM ads_campaigns c JOIN ads_accounts a ON a.id=c.account_id WHERE c.id=$1', [req.params.id]);
    if (!camp) return res.status(404).json({ error: 'Campanha nao encontrada' });
    const cfg = await getConfig();
    if (camp.platform==='meta') await metaSvc.updateCampaignBudget(camp.platform_campaign_id, daily_budget, cfg);
    await pool.query('UPDATE ads_campaigns SET daily_budget=$1 WHERE id=$2', [daily_budget, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/metrics/portfolio', auth, async (req, res) => {
  const { period='30' } = req.query;
  try {
    const { rows:[totals] } = await pool.query(`
      SELECT COALESCE(SUM(spend),0) as total_spend, COALESCE(SUM(leads),0) as total_leads,
             COALESCE(SUM(impressions),0) as total_impressions, COALESCE(SUM(clicks),0) as total_clicks,
             CASE WHEN SUM(leads)>0 THEN SUM(spend)/SUM(leads) ELSE 0 END as avg_cpl,
             COALESCE(SUM(CASE WHEN platform='meta' THEN spend END),0) as meta_spend,
             COALESCE(SUM(CASE WHEN platform='google' THEN spend END),0) as google_spend
      FROM ads_metrics WHERE date >= CURRENT_DATE - $1::INT`, [parseInt(period)]);
    const { rows:byAccount } = await pool.query(`
      SELECT a.client_name, a.client_color, a.client_initials,
             COALESCE(SUM(m.spend),0) as spend, COALESCE(SUM(m.leads),0) as leads,
             CASE WHEN SUM(m.leads)>0 THEN SUM(m.spend)/SUM(m.leads) ELSE NULL END as cpl
      FROM ads_accounts a LEFT JOIN ads_metrics m ON m.account_id=a.id AND m.date>=CURRENT_DATE-$1::INT
      WHERE a.status='active' GROUP BY a.id,a.client_name,a.client_color,a.client_initials ORDER BY spend DESC`, [parseInt(period)]);
    const { rows:trend } = await pool.query(`
      SELECT date, SUM(spend) as spend, SUM(leads) as leads,
             CASE WHEN SUM(leads)>0 THEN SUM(spend)/SUM(leads) ELSE NULL END as cpl
      FROM ads_metrics WHERE date>=CURRENT_DATE-$1::INT GROUP BY date ORDER BY date ASC`, [parseInt(period)]);
    res.json({ totals, byAccount, trend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alerts', auth, async (req, res) => {
  const { resolved='false', account } = req.query;
  let query = `SELECT al.*, a.client_name, a.client_color, c.name as campaign_name, c.platform
    FROM ads_alerts al JOIN ads_accounts a ON a.id=al.account_id
    LEFT JOIN ads_campaigns c ON c.id=al.campaign_id WHERE al.resolved=$1`;
  const params = [resolved==='true'];
  if (account) { params.push(account); query += ` AND al.account_id=$${params.length}`; }
  query += ' ORDER BY al.created_at DESC LIMIT 100';
  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/alerts/:id/resolve', auth, async (req, res) => {
  try {
    await pool.query('UPDATE ads_alerts SET resolved=TRUE, resolved_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync/account/:id', auth, async (req, res) => {
  const start = Date.now();
  try {
    const { rows:[account] } = await pool.query('SELECT * FROM ads_accounts WHERE id=$1', [req.params.id]);
    if (!account) return res.status(404).json({ error: 'Conta nao encontrada' });
    const cfg = await getConfig();
    const result = { meta: null, google: null };
    if (account.meta_ad_account_id && cfg?.meta_connected) {
      const campaigns = await metaSvc.syncAccountCampaigns(account, cfg, pool);
      const metrics = await metaSvc.syncAccountInsights(account, cfg, pool);
      result.meta = { campaigns, metrics };
    }
    if (account.google_customer_id && cfg?.google_connected) {
      const accessToken = await oauth.getValidGoogleToken(pool);
      const campaigns = await googleSvc.syncAccountCampaigns(account, accessToken, pool);
      const metrics = await googleSvc.syncAccountMetrics(account, accessToken, pool);
      result.google = { campaigns, metrics };
    }
    await alertsSvc.runAlertChecks(pool);
    await pool.query('INSERT INTO ads_sync_log (account_id,platform,status,duration_ms,trigger_type) VALUES ($1,$2,$3,$4,$5)',
      [account.id,'all','success',Date.now()-start,'manual']);
    res.json({ success: true, result, duration_ms: Date.now()-start });
  } catch (e) {
    await pool.query('INSERT INTO ads_sync_log (account_id,platform,status,error_message,trigger_type) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id,'all','error',e.message,'manual']);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sync/all', auth, async (req, res) => {
  const results = [];
  try {
    const { rows:accounts } = await pool.query("SELECT * FROM ads_accounts WHERE status='active'");
    const cfg = await getConfig();
    let gToken = null;
    if (cfg?.google_connected) { try { gToken = await oauth.getValidGoogleToken(pool); } catch(e) {} }
    for (const account of accounts) {
      const r = { account: account.client_name, meta: null, google: null };
      try {
        if (account.meta_ad_account_id && cfg?.meta_connected) {
          await metaSvc.syncAccountCampaigns(account, cfg, pool);
          await metaSvc.syncAccountInsights(account, cfg, pool, 7);
          r.meta = 'ok';
        }
        if (account.google_customer_id && gToken) {
          await googleSvc.syncAccountCampaigns(account, gToken, pool);
          await googleSvc.syncAccountMetrics(account, gToken, pool, 7);
          r.google = 'ok';
        }
      } catch (e) { r.error = e.message; }
      results.push(r);
    }
    await alertsSvc.runAlertChecks(pool);
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ error: e.message, results }); }
});

app.post('/api/ai/chat', auth, async (req, res) => {
  const { message, account_id, history=[] } = req.body;
  try {
    const { rows:kpis } = await pool.query('SELECT client_name,month_spend,month_leads,month_cpl,active_campaigns,budget_pct_used FROM ads_account_kpis ORDER BY month_spend DESC');
    const { rows:alerts } = await pool.query(`SELECT a.client_name, al.message, al.severity FROM ads_alerts al JOIN ads_accounts a ON a.id=al.account_id WHERE al.resolved=FALSE ORDER BY al.created_at DESC LIMIT 5`);
    let accountContext = '';
    if (account_id) {
      const { rows:campaigns } = await pool.query(`SELECT c.name,c.platform,c.status,c.daily_budget,m.spend,m.leads,m.cpl,m.date FROM ads_campaigns c LEFT JOIN ads_metrics m ON m.campaign_id=c.id AND m.date=CURRENT_DATE-1 WHERE c.account_id=$1 ORDER BY m.spend DESC NULLS LAST LIMIT 10`, [account_id]);
      if (campaigns.length) accountContext = `\nCampanhas da conta:\n${JSON.stringify(campaigns)}`;
    }
    const systemPrompt = `Voce e VORA Traffic, inteligencia de trafego pago do ecossistema Vohaus.
Conta centralizadora: tarcisioraduntz@gmail.com.

REGRAS CRITICAS:
- Responda APENAS com base nos dados reais fornecidos abaixo
- NUNCA invente dados, metricas ou status de campanhas
- NUNCA escreva codigo Python ou pseudocodigo
- Se nao tiver dados de uma conta, diga claramente: "Nao ha dados sincronizados para esta conta. Use o botao Sync na tela de Clientes."
- Aplique o Metodo BAC apenas quando tiver dados reais para analisar

METODO BAC:
- Ressonancia: o criativo conecta com o decisor?
- Fluxo: o funil tem gargalos pos-clique?
- Homeostase: o CPL esta protegendo a margem?

Tom: clinico, direto. Conclusoes antes de explicacoes. Sem entusiasmo.

DADOS REAIS DO PORTFOLIO:
${JSON.stringify(kpis)}

ALERTAS ATIVOS:
${JSON.stringify(alerts)}
${accountContext}`;
    const messages = [...history.slice(-6), { role:'user', content:message }];
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
          model:'claude-sonnet-4-20250514',
          max_tokens:1500,
          system:systemPrompt,
          messages
        })
    });
    const data = await resp.json();
    res.json({ reply: data.content?.[0]?.text || 'Erro na analise.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/generate-copy', auth, async (req, res) => {
  const { account_id, objective, platform, audience_notes, bac_pillar } = req.body;
  try {
    const { rows:[account] } = await pool.query('SELECT * FROM ads_accounts WHERE id=$1', [account_id]);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1000,
        system:'VORA Traffic. Gere copies de anuncios aplicando Metodo BAC. Tom clinico. Responda SOMENTE em JSON valido.',
        messages:[{ role:'user', content:`Gere copy para: Cliente:${account?.client_name} Segmento:${account?.client_segment} Plataforma:${platform} Objetivo:${objective} Pilar BAC:${bac_pillar||'Ressonancia'} Publico:${audience_notes||'Decisores C-Level B2B'}\nRetorne JSON: {"headline_1":"","headline_2":"","headline_3":"","primary_text":"","cta":"","bac_rationale":""}` }]
      })
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text||'{}';
    try { res.json(JSON.parse(text.replace(/```json|```/g,'').trim())); }
    catch { res.json({ raw: text }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

cron.schedule('0 0,6,12,18 * * *', async () => {
  console.log('[Vohaus Ads] Cron sync iniciado');
  try {
    const { rows:accounts } = await pool.query("SELECT * FROM ads_accounts WHERE status='active'");
    const cfg = await getConfig();
    let gToken = null;
    if (cfg?.google_connected) { try { gToken = await oauth.getValidGoogleToken(pool); } catch(e) { console.error('Google token:', e.message); } }
    for (const acc of accounts) {
      try {
        if (acc.meta_ad_account_id && cfg?.meta_connected) {
          await metaSvc.syncAccountCampaigns(acc, cfg, pool);
          await metaSvc.syncAccountInsights(acc, cfg, pool, 7);
        }
        if (acc.google_customer_id && gToken) {
          await googleSvc.syncAccountCampaigns(acc, gToken, pool);
          await googleSvc.syncAccountMetrics(acc, gToken, pool, 7);
        }
        console.log(`[Cron] ${acc.client_name} ok`);
      } catch(e) { console.error(`[Cron] ${acc.client_name} erro:`, e.message); }
    }
    await alertsSvc.runAlertChecks(pool);
    console.log('[Vohaus Ads] Cron completo');
  } catch (e) { console.error('[Cron] Erro:', e.message); }
});

pool.connect()
  .then(() => {
    console.log('[Vohaus Ads] DB conectado');
    app.listen(PORT, () => console.log(`[Vohaus Ads] Rodando na porta ${PORT}`));
  })
  .catch(e => { console.error('[Vohaus Ads] DB falhou:', e.message); process.exit(1); });

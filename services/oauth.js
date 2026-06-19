const fetch = require('node-fetch');

async function validateMetaToken(token) {
  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name,email&access_token=${token}`);
    const data = await resp.json();
    if (data.error) return { valid: false, error: data.error.message };
    return { valid: true, user: data };
  } catch (e) { return { valid: false, error: e.message }; }
}

async function getMetaAdAccounts(businessId, token) {
  const url = `https://graph.facebook.com/v20.0/${businessId}/owned_ad_accounts?fields=id,name,account_status,currency&limit=50&access_token=${token}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

async function getMetaClientAdAccounts(businessId, token) {
  const url = `https://graph.facebook.com/v20.0/${businessId}/client_ad_accounts?fields=id,name,account_status,currency&limit=50&access_token=${token}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

function buildGoogleAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
    state: 'vohaus_ads_auth'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeGoogleCode(code, clientId, clientSecret, redirectUri) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function refreshGoogleToken(refreshToken, clientId, clientSecret) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function getValidGoogleToken(pool) {
  const { rows: [cfg] } = await pool.query('SELECT * FROM ads_config WHERE id = 1');
  if (!cfg?.google_refresh_token) throw new Error('Google nao configurado. Conecte em /settings.');
  const now = new Date();
  const expiresAt = cfg.google_token_expires_at ? new Date(cfg.google_token_expires_at) : null;
  const isExpired = !expiresAt || now >= new Date(expiresAt.getTime() - 5 * 60 * 1000);
  if (!isExpired && cfg.google_access_token) return cfg.google_access_token;
  const newTokens = await refreshGoogleToken(cfg.google_refresh_token, process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  const newExpiry = new Date(Date.now() + newTokens.expires_in * 1000);
  await pool.query('UPDATE ads_config SET google_access_token=$1, google_token_expires_at=$2, updated_at=NOW() WHERE id=1', [newTokens.access_token, newExpiry]);
  return newTokens.access_token;
}

async function listGoogleAccessibleAccounts(accessToken) {
  const resp = await fetch('https://googleads.googleapis.com/v17/customers:listAccessibleCustomers', {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN }
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return (data.resourceNames || []).map(r => r.replace('customers/', ''));
}

module.exports = { validateMetaToken, getMetaAdAccounts, getMetaClientAdAccounts, buildGoogleAuthUrl, exchangeGoogleCode, getValidGoogleToken, listGoogleAccessibleAccounts };

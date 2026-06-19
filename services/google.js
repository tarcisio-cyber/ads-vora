const fetch = require('node-fetch');
const GADS_BASE = 'https://googleads.googleapis.com/v17';

function buildHeaders(accessToken, loginCustomerId=null) {
  const h = { 'Authorization':`Bearer ${accessToken}`, 'developer-token':process.env.GOOGLE_ADS_DEVELOPER_TOKEN, 'Content-Type':'application/json' };
  if (loginCustomerId) h['login-customer-id'] = loginCustomerId.replace(/-/g,'');
  return h;
}

async function gaqlQuery(customerId, query, accessToken, loginCustomerId) {
  const cleanId = customerId.replace(/-/g,'');
  const resp = await fetch(`${GADS_BASE}/customers/${cleanId}/googleAds:search`, {
    method:'POST', headers:buildHeaders(accessToken, loginCustomerId), body:JSON.stringify({query})
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Google Ads [${customerId}]: ${data.error.message}`);
  return data.results || [];
}

async function syncAccountCampaigns(account, accessToken, pool) {
  const customerId = account.google_customer_id.replace(/-/g,'');
  const mccId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const query = `SELECT campaign.id,campaign.name,campaign.status,campaign.advertising_channel_type,campaign.start_date,campaign.end_date,campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`;
  const results = await gaqlQuery(customerId, query, accessToken, mccId);
  let count = 0;
  for (const row of results) {
    const camp = row.campaign;
    const budget = row.campaignBudget;
    const dailyBudget = budget?.amountMicros ? parseInt(budget.amountMicros)/1000000 : null;
    const status = {'ENABLED':'ACTIVE','PAUSED':'PAUSED','REMOVED':'DELETED'}[camp.status] || camp.status;
    await pool.query(
      `INSERT INTO ads_campaigns (account_id,platform,platform_campaign_id,name,objective,status,daily_budget,start_date,end_date,last_synced_at,metadata)
       VALUES ($1,'google',$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
       ON CONFLICT (platform,platform_campaign_id) DO UPDATE SET name=$3,status=$5,daily_budget=$6,end_date=$8,last_synced_at=NOW(),sync_error=NULL`,
      [account.id,camp.id.toString(),camp.name,camp.advertisingChannelType,status,dailyBudget,
       camp.startDate||null, camp.endDate&&camp.endDate!=='2037-12-30'?camp.endDate:null,
       JSON.stringify({channelType:camp.advertisingChannelType})]
    );
    count++;
  }
  return count;
}

async function syncAccountMetrics(account, accessToken, pool, daysBack=30) {
  const customerId = account.google_customer_id.replace(/-/g,'');
  const mccId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const since = new Date(); since.setDate(since.getDate()-daysBack);
  const sinceStr = since.toISOString().split('T')[0].replace(/-/g,'');
  const untilStr = new Date().toISOString().split('T')[0].replace(/-/g,'');
  const query = `SELECT campaign.id,segments.date,metrics.impressions,metrics.clicks,metrics.ctr,metrics.average_cpc,metrics.average_cpm,metrics.cost_micros,metrics.conversions,metrics.cost_per_conversion FROM campaign WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}' AND campaign.status != 'REMOVED' ORDER BY segments.date DESC`;
  const results = await gaqlQuery(customerId, query, accessToken, mccId);
  let count = 0;
  for (const row of results) {
    const { rows:[camp] } = await pool.query("SELECT id FROM ads_campaigns WHERE platform_campaign_id=$1 AND platform='google'", [row.campaign.id.toString()]);
    if (!camp) continue;
    const spend = parseInt(row.metrics.costMicros||0)/1000000;
    const conversions = parseFloat(row.metrics.conversions||0);
    const leads = Math.round(conversions);
    const cpl = leads>0 ? spend/leads : null;
    const cpa = conversions>0 ? spend/conversions : null;
    const rawDate = row.segments.date;
    const date = `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`;
    await pool.query(
      `INSERT INTO ads_metrics (campaign_id,account_id,date,platform,impressions,clicks,ctr,cpc,cpm,spend,conversions,leads,cpa,cpl,raw_data)
       VALUES ($1,$2,$3,'google',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (campaign_id,date) DO UPDATE SET impressions=$4,clicks=$5,ctr=$6,cpc=$7,cpm=$8,spend=$9,conversions=$10,leads=$11,cpa=$12,cpl=$13,raw_data=$14`,
      [camp.id,account.id,date,parseInt(row.metrics.impressions||0),parseInt(row.metrics.clicks||0),
       parseFloat(row.metrics.ctr||0),parseInt(row.metrics.averageCpc||0)/1000000,parseInt(row.metrics.averageCpm||0)/1000000,
       spend,conversions,leads,cpa,cpl,JSON.stringify(row.metrics)]
    );
    count++;
  }
  return count;
}

async function updateCampaignStatus(customerId, platformCampaignId, status, accessToken) {
  const mccId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const cleanId = customerId.replace(/-/g,'');
  const googleStatus = status==='ACTIVE' ? 'ENABLED' : 'PAUSED';
  const resp = await fetch(`${GADS_BASE}/customers/${cleanId}/campaigns:mutate`, {
    method:'POST', headers:buildHeaders(accessToken,mccId),
    body:JSON.stringify({operations:[{update:{resourceName:`customers/${cleanId}/campaigns/${platformCampaignId}`,status:googleStatus},updateMask:'status'}]})
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

module.exports = { syncAccountCampaigns, syncAccountMetrics, updateCampaignStatus };

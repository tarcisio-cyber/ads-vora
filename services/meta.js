const fetch = require('node-fetch');
const META_BASE = 'https://graph.facebook.com/v20.0';

function getToken(config) {
  if (!config?.meta_system_user_token) throw new Error('Meta nao configurado. Adicione o System User Token em Configuracoes.');
  return config.meta_system_user_token;
}

async function syncAccountCampaigns(account, config, pool) {
  const token = getToken(config);
  const accountId = account.meta_ad_account_id.replace('act_','');
  const fields = 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time';
  const url = `${META_BASE}/act_${accountId}/campaigns?fields=${fields}&limit=50&access_token=${token}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error(`Meta [${account.client_name}]: ${data.error.message}`);
  let count = 0;
  for (const camp of data.data || []) {
    await pool.query(
      `INSERT INTO ads_campaigns (account_id,platform,platform_campaign_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_date,end_date,last_synced_at)
       VALUES ($1,'meta',$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (platform,platform_campaign_id) DO UPDATE SET
         name=$3,status=$5,effective_status=$6,daily_budget=$7,lifetime_budget=$8,end_date=$10,last_synced_at=NOW(),sync_error=NULL`,
      [account.id, camp.id, camp.name, camp.objective, camp.status, camp.effective_status,
       camp.daily_budget ? Math.round(camp.daily_budget)/100 : null,
       camp.lifetime_budget ? Math.round(camp.lifetime_budget)/100 : null,
       camp.start_time ? camp.start_time.split('T')[0] : null,
       camp.stop_time ? camp.stop_time.split('T')[0] : null]
    );
    count++;
  }
  return count;
}

async function syncAccountInsights(account, config, pool, daysBack=30) {
  const token = getToken(config);
  const accountId = account.meta_ad_account_id.replace('act_','');
  const since = new Date(); since.setDate(since.getDate()-daysBack);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = new Date().toISOString().split('T')[0];
  const fields = 'campaign_id,impressions,reach,frequency,clicks,ctr,cpc,cpm,spend,actions,cost_per_action_type';
  const params = new URLSearchParams({ fields, level:'campaign', time_increment:'1', time_range: JSON.stringify({since:sinceStr,until:untilStr}), limit:'500', access_token:token });
  const url = `${META_BASE}/act_${accountId}/insights?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error(`Meta Insights [${account.client_name}]: ${data.error.message}`);
  let count = 0;
  for (const row of data.data || []) {
    const { rows:[camp] } = await pool.query("SELECT id FROM ads_campaigns WHERE platform_campaign_id=$1 AND platform='meta'", [row.campaign_id]);
    if (!camp) continue;
    const actions = row.actions || [];
    const leads = parseInt(actions.find(a=>a.action_type==='lead'||a.action_type==='offsite_conversion.fb_pixel_lead')?.value||0);
    const conversions = parseInt(actions.find(a=>a.action_type==='offsite_conversion.fb_pixel_purchase')?.value||0);
    const spend = parseFloat(row.spend||0);
    const cpl = leads>0 ? spend/leads : null;
    const cpa = conversions>0 ? spend/conversions : null;
    await pool.query(
      `INSERT INTO ads_metrics (campaign_id,account_id,date,platform,impressions,reach,frequency,clicks,ctr,cpc,cpm,spend,leads,conversions,cpl,cpa,raw_data)
       VALUES ($1,$2,$3,'meta',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (campaign_id,date) DO UPDATE SET
         impressions=$4,reach=$5,frequency=$6,clicks=$7,ctr=$8,cpc=$9,cpm=$10,spend=$11,leads=$12,conversions=$13,cpl=$14,cpa=$15,raw_data=$16`,
      [camp.id,account.id,row.date_start,parseInt(row.impressions||0),parseInt(row.reach||0),parseFloat(row.frequency||0),
       parseInt(row.clicks||0),parseFloat(row.ctr||0)/100,parseFloat(row.cpc||0),parseFloat(row.cpm||0),
       spend,leads,conversions,cpl,cpa,JSON.stringify(row)]
    );
    count++;
  }
  return count;
}

async function updateCampaignStatus(platformCampaignId, status, config) {
  const token = getToken(config);
  const resp = await fetch(`${META_BASE}/${platformCampaignId}`, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({status, access_token:token})
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function updateCampaignBudget(platformCampaignId, dailyBudgetReais, config) {
  const token = getToken(config);
  const resp = await fetch(`${META_BASE}/${platformCampaignId}`, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({daily_budget: Math.round(dailyBudgetReais*100), access_token:token})
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

module.exports = { syncAccountCampaigns, syncAccountInsights, updateCampaignStatus, updateCampaignBudget };

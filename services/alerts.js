async function runAlertChecks(pool) {
  const results = { created: 0, errors: [] };
  try { results.created += await checkCplSpike(pool); } catch(e) { results.errors.push('cpl: '+e.message); }
  try { results.created += await checkBudgetThreshold(pool); } catch(e) { results.errors.push('budget: '+e.message); }
  try { results.created += await checkHighFrequency(pool); } catch(e) { results.errors.push('freq: '+e.message); }
  return results;
}

async function checkCplSpike(pool) {
  const { rows } = await pool.query(`
    SELECT c.id as campaign_id, c.name, c.account_id,
           today.cpl as today_cpl, yest.cpl as yesterday_cpl, a.client_name
    FROM ads_campaigns c
    JOIN ads_metrics today ON today.campaign_id = c.id AND today.date = CURRENT_DATE
    JOIN ads_metrics yest  ON yest.campaign_id  = c.id AND yest.date  = CURRENT_DATE - 1
    JOIN ads_accounts a    ON a.id = c.account_id
    WHERE today.cpl IS NOT NULL AND yest.cpl IS NOT NULL
      AND today.cpl > yest.cpl * 1.30 AND today.leads > 0
  `);
  let count = 0;
  for (const row of rows) {
    const existing = await pool.query(`SELECT id FROM ads_alerts WHERE campaign_id=$1 AND type='cpl_spike' AND DATE(created_at)=CURRENT_DATE AND resolved=FALSE`, [row.campaign_id]);
    if (existing.rows.length) continue;
    const pct = Math.round((row.today_cpl / row.yesterday_cpl - 1) * 100);
    await pool.query(`INSERT INTO ads_alerts (account_id,campaign_id,type,severity,message,metric_value,metric_threshold) VALUES ($1,$2,'cpl_spike','critical',$3,$4,$5)`,
      [row.account_id, row.campaign_id, `${row.client_name} - "${row.name}": CPL subiu ${pct}% - Atual: R$ ${parseFloat(row.today_cpl).toFixed(2)}`, parseFloat(row.today_cpl), parseFloat(row.yesterday_cpl)]);
    count++;
  }
  return count;
}

async function checkBudgetThreshold(pool) {
  const { rows } = await pool.query(`
    SELECT a.id as account_id, a.client_name, a.monthly_budget_target,
           COALESCE(SUM(m.spend),0) as month_spend
    FROM ads_accounts a
    LEFT JOIN ads_campaigns c ON c.account_id = a.id
    LEFT JOIN ads_metrics m ON m.campaign_id = c.id AND m.date >= DATE_TRUNC('month',CURRENT_DATE)
    WHERE a.monthly_budget_target IS NOT NULL AND a.monthly_budget_target > 0
    GROUP BY a.id, a.client_name, a.monthly_budget_target
  `);
  let count = 0;
  for (const row of rows) {
    const pct = row.month_spend / row.monthly_budget_target;
    if (pct < 0.8) continue;
    const type = pct >= 1.0 ? 'budget_100' : 'budget_80';
    const severity = pct >= 1.0 ? 'critical' : 'warning';
    const existing = await pool.query(`SELECT id FROM ads_alerts WHERE account_id=$1 AND type=$2 AND DATE(created_at)=CURRENT_DATE AND resolved=FALSE`, [row.account_id, type]);
    if (existing.rows.length) continue;
    const remaining = Math.max(0, row.monthly_budget_target - row.month_spend);
    await pool.query(`INSERT INTO ads_alerts (account_id,type,severity,message,metric_value,metric_threshold) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.account_id, type, severity, `${row.client_name}: Budget em ${Math.round(pct*100)}% - R$ ${remaining.toFixed(0)} restantes`, parseFloat(row.month_spend), parseFloat(row.monthly_budget_target)]);
    count++;
  }
  return count;
}

async function checkHighFrequency(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (c.id) c.id as campaign_id, c.name, c.account_id, a.client_name, m.frequency
    FROM ads_campaigns c
    JOIN ads_metrics m ON m.campaign_id = c.id AND m.platform = 'meta'
    JOIN ads_accounts a ON a.id = c.account_id
    WHERE m.date >= CURRENT_DATE - 3 AND m.frequency > 4.0 AND c.status = 'ACTIVE'
    ORDER BY c.id, m.date DESC
  `);
  let count = 0;
  for (const row of rows) {
    const existing = await pool.query(`SELECT id FROM ads_alerts WHERE campaign_id=$1 AND type='high_frequency' AND created_at > NOW()-INTERVAL '3 days' AND resolved=FALSE`, [row.campaign_id]);
    if (existing.rows.length) continue;
    await pool.query(`INSERT INTO ads_alerts (account_id,campaign_id,type,severity,message,metric_value,metric_threshold) VALUES ($1,$2,'high_frequency','warning',$3,$4,4.0)`,
      [row.account_id, row.campaign_id, `${row.client_name} - "${row.name}": Frequencia ${parseFloat(row.frequency).toFixed(1)} - Saturacao de audiencia`, parseFloat(row.frequency)]);
    count++;
  }
  return count;
}

module.exports = { runAlertChecks };

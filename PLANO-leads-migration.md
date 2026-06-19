# Plano — Correção da contagem de leads (Meta) + campo `conversations`

> **Status:** ADIADO para sessão futura. Nada aplicado ao `meta.js` nem ao banco.
> Envolve `ALTER TABLE` + deploy + re-sync em **ordem obrigatória** — fazer com calma.

## Contexto / diagnóstico

A conta **Levmed** mostrava `leads=0` apesar de ~R$663 de gasto. Investigação confirmou:

- **O gasto está em campanhas que NÃO são de lead** (`OUTCOME_TRAFFIC` R$485,52 + `OUTCOME_AWARENESS` R$179,88) → `leads=0` está correto para esse gasto. (Hipótese B)
- **Mas há bug latente de cobertura** (Hipótese A): o código conta lead só via `lead` / `offsite_conversion.fb_pixel_lead`, e usa `find()` (pega só o **primeiro** action_type que casa). Ignora:
  - `onsite_conversion.lead_grouped` (Formulário Instantâneo / Lead Ads)
  - `onsite_conversion.messaging_conversation_started_7d` (WhatsApp/Messenger) — presente na Levmed
  - `offsite_conversion.custom.*` (conversão personalizada — **fora de escopo**, tratar por conta depois)

## Decisões finais

1. **Leads — dedup conservador:** se existir o `action_type` agregado `lead`, usa **só ele**; senão, **soma os subtipos**. Nunca somar `lead` + subtipos (evita contar 2×).
2. **WhatsApp** (`onsite_conversion.messaging_conversation_started_7d`): **NÃO** conta como lead → vai em **campo separado** `conversations`.
3. **NÃO** incluir `offsite_conversion.custom.*` na regra geral (específico de conta, tratar depois).

---

## 1. Diff proposto do `services/meta.js`

### Hunk A — cálculo de leads (dedup) + variável `conversations` (substitui as linhas ~51-56 em `syncAccountInsights`)

```diff
     const actions = row.actions || [];
-    const leads = parseInt(actions.find(a=>a.action_type==='lead'||a.action_type==='offsite_conversion.fb_pixel_lead')?.value||0);
-    const conversions = parseInt(actions.find(a=>a.action_type==='offsite_conversion.fb_pixel_purchase')?.value||0);
+    const sumActions = (types) => actions.filter(a=>types.includes(a.action_type)).reduce((s,a)=>s+parseInt(a.value||0),0);
+    // 'lead' agregado tem prioridade; senao soma subtipos (dedup, evita contar 2x)
+    const leads = actions.some(a=>a.action_type==='lead')
+      ? sumActions(['lead'])
+      : sumActions(['offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped','leadgen_grouped','leadgen.other']);
+    // Conversas iniciadas (WhatsApp/Messenger) - metrica separada, NAO conta como lead
+    const conversations = sumActions(['onsite_conversion.messaging_conversation_started_7d']);
+    const conversions = parseInt(actions.find(a=>a.action_type==='offsite_conversion.fb_pixel_purchase')?.value||0);
     const spend = parseFloat(row.spend||0);
     const cpl = leads>0 ? spend/leads : null;
     const cpa = conversions>0 ? spend/conversions : null;
```

> **Nota:** `leadgen_grouped` e `leadgen.other` estão incluídos como variantes de Lead Ads, mas é um **ponto em aberto** (ver abaixo) — decidir se mantém ou restringe estritamente a `offsite_conversion.fb_pixel_lead` + `onsite_conversion.lead_grouped`.

### Hunk B — persistir `conversations` no INSERT (linhas ~57-65, adicionando `$17`)

```diff
     await pool.query(
-      `INSERT INTO ads_metrics (campaign_id,account_id,date,platform,impressions,reach,frequency,clicks,ctr,cpc,cpm,spend,leads,conversions,cpl,cpa,raw_data)
-       VALUES ($1,$2,$3,'meta',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
+      `INSERT INTO ads_metrics (campaign_id,account_id,date,platform,impressions,reach,frequency,clicks,ctr,cpc,cpm,spend,leads,conversions,cpl,cpa,raw_data,conversations)
+       VALUES ($1,$2,$3,'meta',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (campaign_id,date) DO UPDATE SET
-         impressions=$4,reach=$5,frequency=$6,clicks=$7,ctr=$8,cpc=$9,cpm=$10,spend=$11,leads=$12,conversions=$13,cpl=$14,cpa=$15,raw_data=$16`,
+         impressions=$4,reach=$5,frequency=$6,clicks=$7,ctr=$8,cpc=$9,cpm=$10,spend=$11,leads=$12,conversions=$13,cpl=$14,cpa=$15,raw_data=$16,conversations=$17`,
       [camp.id,account.id,row.date_start,parseInt(row.impressions||0),parseInt(row.reach||0),parseFloat(row.frequency||0),
        parseInt(row.clicks||0),parseFloat(row.ctr||0)/100,parseFloat(row.cpc||0),parseFloat(row.cpm||0),
-       spend,leads,conversions,cpl,cpa,JSON.stringify(row)]
+       spend,leads,conversions,cpl,cpa,JSON.stringify(row),conversations]
     );
```

> Se renomear o campo (ver ponto em aberto), trocar `conversations` por `whatsapp_conversations` no Hunk A, no Hunk B e na migração.

---

## 2. Migração (obrigatória se aplicar o Hunk B)

A tabela `ads_metrics` não tem coluna `conversations`. Comando:

```sql
ALTER TABLE ads_metrics ADD COLUMN IF NOT EXISTS conversations INT DEFAULT 0;
```

Também atualizar o `schema.sql` (perto da linha ~80, junto de `leads/conversions`) para instalações novas ficarem consistentes:

```sql
  conversations INT DEFAULT 0,
```

### Impacto (verificado — não-destrutivo)

| Item | Afetado? | Detalhe |
|---|---|---|
| View `ads_account_kpis` | NÃO | Não referencia `conversations`. Continua intacta. (Se quiser `month_conversations`, exige `CREATE OR REPLACE VIEW` à parte.) |
| `services/google.js` (grava `ads_metrics`) | NÃO | INSERT com lista explícita de colunas, sem `conversations` → com `DEFAULT 0` grava 0. |
| Frontend (`/api/campaigns`, portfolio) | NÃO | Queries com colunas explícitas (`date,spend,leads,cpl,impressions,clicks,ctr`), sem `*`. Campo só aparece se decidirmos exibir depois. |
| Linhas existentes | conversations=0 até re-sync | O re-sync regrava via `ON CONFLICT DO UPDATE`. |

---

## 3. Ordem de execução OBRIGATÓRIA

1. Rodar o `ALTER TABLE` no banco (senão o INSERT novo falha por coluna inexistente)
2. Atualizar `schema.sql` (coluna nova) + aplicar Hunks A/B no `meta.js` + commit
3. Deploy do `meta.js` corrigido
4. Re-sync da Levmed: `POST /api/sync/account/:id` (ou `/api/sync/all`) — reprocessa insights e regrava `leads`/`cpl`/`conversations`

---

## 4. Pontos em aberto (decidir na retomada)

1. **Nome do campo:** `conversations` vs `whatsapp_conversations` (ou `messaging_conversations`).
   - Risco: já existe coluna `conversions` (compras via pixel) — `conversations` fica quase idêntico, fácil de confundir em queries. Recomendação: nome menos ambíguo.
2. **Subtipos de lead:** manter `leadgen_grouped` e `leadgen.other` na soma de subtipos, ou restringir estritamente a `offsite_conversion.fb_pixel_lead` + `onsite_conversion.lead_grouped` (os que foram nomeados explicitamente)?

---

## Bug secundário corrigido de quebra

O `find()` original pegava só o **primeiro** action_type. A nova lógica (`filter`+`reduce` nos subtipos) soma todos os presentes — corrige subcontagem em contas com múltiplos tipos de lead.

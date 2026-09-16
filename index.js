import { createClient } from '@supabase/supabase-js';

const METABASE_URL = 'https://plmb.shopup.center';

const CARD_DAILY_SUMMARY = 237998; // cpg-db-wise-order-to-deposit-walkthrough-v2
const CARD_DEPOSITS = 15633;       // deposits-breakdown-with-cheques-live-query

const DAYS_LOOKBACK = 2;
const UPSERT_BATCH_SIZE = 500;

// Set true per-card only if that card's date variables are Field Filters
// (mapped to a column) rather than plain SQL Variables. Check via the gear
// icon next to the variable in each Metabase question's editor.
const CARD_CONFIG = {
  [CARD_DAILY_SUMMARY]: { fromTag: 'from', toTag: 'to', useFieldFilter: false },
  [CARD_DEPOSITS]: { fromTag: 'From', toTag: 'To', useFieldFilter: false }, // confirm casing/type via dry run
};

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function buildParameters(cardId, fromDate, toDate) {
  const { fromTag, toTag, useFieldFilter } = CARD_CONFIG[cardId];
  const targetFor = (tag) =>
    useFieldFilter ? ['dimension', ['template-tag', tag]] : ['variable', ['template-tag', tag]];

  return [
    { type: 'date/single', target: targetFor(fromTag), value: fromDate },
    { type: 'date/single', target: targetFor(toTag), value: toDate },
  ];
}

async function fetchMetabaseRows(sessionToken, cardId, fromDate, toDate) {
  const parameters = buildParameters(cardId, fromDate, toDate);

  const url = `${METABASE_URL}/api/card/${cardId}/query/json?parameters=${encodeURIComponent(
    JSON.stringify(parameters)
  )}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionToken },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Metabase session token invalid/expired while fetching card ${cardId}. ` +
      'Refresh the METABASE_SESSION_TOKEN repository secret.'
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Metabase API error for card ${cardId} (${res.status}): ${body.slice(0, 500)}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected response shape for card ${cardId}: ${JSON.stringify(rows).slice(0, 500)}`);
  }
  return rows;
}

async function upsertInBatches(supabase, table, records, onConflict) {
  let synced = 0;
  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed at row ${i}: ${error.message}`);
    synced += batch.length;
  }
  console.log(`  ${table}: synced ${synced} record(s).`);
  return synced;
}

// --- Transform: card 237998 rows -> dim_distributor + fct_db_daily_summary ---
function transformDailySummary(rows) {
  const distributors = new Map();
  const summaries = [];

  for (const r of rows) {
    if (!distributors.has(r.DB_ID)) {
      distributors.set(r.DB_ID, {
        db_id: r.DB_ID,
        db_name: r.DB,
        anchor_type: r.Anchor_Type,
        sub_anchor_type: r.Sub_Anchor_Type,
        db_house_status: r.DB_House_Status,
      });
    }
    summaries.push({
      order_date: r.Date?.slice(0, 10) ?? r.Date,
      db_id: r.DB_ID,
      sales: r.Sales,
      market_damage: r.Market_Damage,
      nmv: r.NMV,
      claim: r.Claim,
      non_claim: r.Non_Claim,
      market_short_given: r.Market_Short_Given,
      market_short_collection: r.Market_Short_Collection,
      credit_given: r.Credit_Given,
      credit_collection: r.Credit_Collection,
      sim_receivable: r.SIM_Receivable,
      sim_receivable_collection: r.SIM_Receivable_Collection,
      dsr_incentive_withdrawal: r.DSR_Incentive_Withdrawal,
      cash_collection: r.Cash_Collection,
    });
  }

  return { distributors, summaries };
}

// --- Transform: card 15633 rows -> deposits + deposit_transactions (+ distributor fallback) ---
function transformDeposits(rows, distributors) {
  const deposits = new Map();
  const transactions = [];

  for (const r of rows) {
    if (!distributors.has(r.db_id)) {
      // Fallback stub if this db_id never appeared in the daily summary card
      distributors.set(r.db_id, {
        db_id: r.db_id,
        db_name: r.db_name,
        anchor_type: null,
        sub_anchor_type: null,
        db_house_status: null,
      });
    }

    const existingDeposit = deposits.get(r.deposit_id);
    const updatedAt = r.updated_at;
    if (!existingDeposit || new Date(updatedAt) > new Date(existingDeposit.updated_at)) {
      deposits.set(r.deposit_id, {
        deposit_id: r.deposit_id,
        db_id: r.db_id,
        order_date: r.order_date?.slice(0, 10) ?? r.order_date,
        created_at: r.created_at,
        updated_at: updatedAt,
      });
    }

    transactions.push({
      deposit_transaction_id: r.deposit_transaction_id,
      deposit_id: r.deposit_id,
      deposit_amount: r.deposit_amount,
      account_name: r.account_name,
      account_type: r.account_type,
      deposit_charge: r.deposit_charge,
      utr_or_cheque_number: r.UTR_or_Cheque_Number,
      transaction_approval_status: r.transaction_approval_status,
      verified_by: r.verified_by,
      rejection_reason: r.rejection_reason,
      deposit_slip_date: r.deposit_slip_date?.slice(0, 10) ?? r.deposit_slip_date,
      deposit_slip_url: r.deposit_slip_url,
    });
  }

  return { deposits, transactions };
}

async function syncMetabaseToSupabase() {
  const METABASE_SESSION_TOKEN = process.env.METABASE_SESSION_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const DRY_RUN = process.env.DRY_RUN === 'true';

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !METABASE_SESSION_TOKEN) {
    throw new Error('Missing required secrets in GitHub environment variables.');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - DAYS_LOOKBACK);
  const fromDate = formatDate(from);
  const toDate = formatDate(to);

  console.log(`Fetching Metabase data from ${fromDate} to ${toDate}...`);

  const dailySummaryRows = await fetchMetabaseRows(METABASE_SESSION_TOKEN, CARD_DAILY_SUMMARY, fromDate, toDate);
  console.log(`Card ${CARD_DAILY_SUMMARY}: retrieved ${dailySummaryRows.length} rows.`);

  const depositRows = await fetchMetabaseRows(METABASE_SESSION_TOKEN, CARD_DEPOSITS, fromDate, toDate);
  console.log(`Card ${CARD_DEPOSITS}: retrieved ${depositRows.length} rows.`);

  const { distributors, summaries } = transformDailySummary(dailySummaryRows);
  const { deposits, transactions } = transformDeposits(depositRows, distributors);

  if (DRY_RUN) {
    console.log('DRY_RUN enabled — skipping Supabase write. Sample records:');
    console.log('dim_distributor:', JSON.stringify([...distributors.values()][0], null, 2));
    console.log('fct_db_daily_summary:', JSON.stringify(summaries[0], null, 2));
    console.log('deposits:', JSON.stringify([...deposits.values()][0], null, 2));
    console.log('deposit_transactions:', JSON.stringify(transactions[0], null, 2));
    return;
  }

  // Order matters: parents before children, due to FK constraints.
  await upsertInBatches(supabase, 'dim_distributor', [...distributors.values()], 'db_id');
  await upsertInBatches(supabase, 'fct_db_daily_summary', summaries, 'order_date,db_id');
  await upsertInBatches(supabase, 'deposits', [...deposits.values()], 'deposit_id');
  await upsertInBatches(supabase, 'deposit_transactions', transactions, 'deposit_transaction_id');

  console.log('Sync complete.');
}

syncMetabaseToSupabase().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

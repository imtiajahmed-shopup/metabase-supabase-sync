import { createClient } from '@supabase/supabase-js';

const METABASE_URL = 'https://plmb.shopup.center';
const METABASE_CARD_ID = 237998;

// TODO: confirm with your target table's actual unique constraint
const TARGET_TABLE = 'your_target_table';
const CONFLICT_COLUMNS = 'order_id'; // e.g. 'order_id,deposit_date' for a composite key

// How many days back to pull, and batch size for the Supabase write
const DAYS_LOOKBACK = 2;
const UPSERT_BATCH_SIZE = 500;

// Set true only if your question's `from`/`to` variables are Field Filters
// (mapped to a specific column) rather than plain SQL Variables.
// Check via the gear icon next to {{from}} in the Metabase question editor.
const USE_FIELD_FILTER_TARGET = false;

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function buildParameters(fromDate, toDate) {
  const targetFor = (tag) =>
    USE_FIELD_FILTER_TARGET ? ['dimension', ['template-tag', tag]] : ['variable', ['template-tag', tag]];

  return [
    { type: 'date/single', target: targetFor('from'), value: fromDate },
    { type: 'date/single', target: targetFor('to'), value: toDate },
  ];
}

async function fetchMetabaseRows(sessionToken, fromDate, toDate) {
  const parameters = buildParameters(fromDate, toDate);

  // Using the /query/json export endpoint (not /query) to avoid Metabase's
  // hard 2,000-row cap on the interactive query endpoint. This endpoint
  // requires `parameters` as a URL-encoded query string, and returns a flat
  // array of row objects (no separate cols/rows structure to reassemble).
  const url = `${METABASE_URL}/api/card/${METABASE_CARD_ID}/query/json?parameters=${encodeURIComponent(
    JSON.stringify(parameters)
  )}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionToken },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Metabase session token is invalid or expired (Metabase sessions default to 14 days). ' +
      'Log into Metabase in your browser, grab a fresh session token, and update the ' +
      'METABASE_SESSION_TOKEN repository secret.'
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Metabase API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const rows = await res.json();

  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected Metabase response shape: ${JSON.stringify(rows).slice(0, 500)}`);
  }

  return rows;
}

async function upsertInBatches(supabase, records) {
  let synced = 0;
  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase.from(TARGET_TABLE).upsert(batch, { onConflict: CONFLICT_COLUMNS });
    if (error) throw new Error(`Supabase upsert failed on batch starting at row ${i}: ${error.message}`);
    synced += batch.length;
    console.log(`  Synced ${synced}/${records.length} records...`);
  }
  return synced;
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

  const rows = await fetchMetabaseRows(METABASE_SESSION_TOKEN, fromDate, toDate);
  console.log(`Retrieved ${rows.length} rows from Metabase.`);

  if (rows.length === 0) {
    console.log('No records returned for the selected range.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY_RUN is enabled — skipping Supabase write. Sample record:');
    console.log(JSON.stringify(rows[0], null, 2));
    return;
  }

  const synced = await upsertInBatches(supabase, rows);
  console.log(`Successfully synced ${synced} records to Supabase!`);
}

syncMetabaseToSupabase().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

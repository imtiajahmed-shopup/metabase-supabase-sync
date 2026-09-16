import { createClient } from '@supabase/supabase-js';

const METABASE_URL = 'https://plmb.shopup.center';
const METABASE_CARD_ID = 237998;

async function syncMetabaseToSupabase() {
  const METABASE_SESSION_TOKEN = process.env.METABASE_SESSION_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !METABASE_SESSION_TOKEN) {
    throw new Error("Missing required secrets in GitHub environment variables.");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Calculate dynamic date range for the previous 2 days (YYYY-MM-DD)
  const today = new Date();
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(today.getDate() - 2);

  const formatDate = (date) => date.toISOString().split('T')[0];
  const fromDate = formatDate(twoDaysAgo);
  const toDate = formatDate(today);

  console.log(`Fetching Metabase data from ${fromDate} to ${toDate}...`);

  // 2. Pass filter parameters to Metabase query
  const queryPayload = {
    parameters: [
      {
        type: "date/single",
        target: ["variable", ["template-tag", "from"]],
        value: fromDate
      },
      {
        type: "date/single",
        target: ["variable", ["template-tag", "to"]],
        value: toDate
      }
    ]
  };

  // 3. Request data with parameters
  const queryRes = await fetch(`${METABASE_URL}/api/card/${METABASE_CARD_ID}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': METABASE_SESSION_TOKEN
    },
    body: JSON.stringify(queryPayload)
  });

  const queryData = await queryRes.json();

  if (!queryRes.ok || !queryData.data) {
    throw new Error(`Metabase API error: ${queryData.message || 'Session expired or invalid filters'}`);
  }

  const columns = queryData.data.cols.map(col => col.name);
  const rows = queryData.data.rows;

  const formattedRecords = rows.map(row => {
    let obj = {};
    columns.forEach((colName, index) => {
      obj[colName] = row[index];
    });
    return obj;
  });

  if (formattedRecords.length === 0) {
    console.log('No records returned for the selected 2-day range.');
    return;
  }

  // 4. Upsert filtered records to Supabase
  const { data, error } = await supabase
    .from('your_target_table') // Replace with your exact Supabase table name
    .upsert(formattedRecords);

  if (error) throw error;
  console.log(`Successfully synced ${formattedRecords.length} records from the last 2 days to Supabase!`);
}

syncMetabaseToSupabase().catch(err => {
  console.error(err);
  process.exit(1);
});

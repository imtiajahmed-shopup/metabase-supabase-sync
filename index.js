import { createClient } from '@supabase/supabase-js';

const METABASE_URL = 'https://plmb.shopup.center';
const METABASE_CARD_ID = 237998;

const METABASE_SESSION_TOKEN = process.env.METABASE_SESSION_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function syncMetabaseToSupabase() {
  console.log('Fetching Metabase question results...');

  const queryRes = await fetch(`${METABASE_URL}/api/card/${METABASE_CARD_ID}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': METABASE_SESSION_TOKEN
    }
  });

  const queryData = await queryRes.json();

  if (!queryRes.ok || !queryData.data) {
    throw new Error(`Metabase API error: ${queryData.message || 'Session expired or unauthorized'}`);
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
    console.log('No records returned from Metabase.');
    return;
  }

  const { data, error } = await supabase
    .from('your_target_table') // Replace with your target Supabase table name
    .upsert(formattedRecords);

  if (error) throw error;
  console.log(`Successfully synced ${formattedRecords.length} rows to Supabase!`);
}

syncMetabaseToSupabase().catch(err => {
  console.error(err);
  process.exit(1);
});

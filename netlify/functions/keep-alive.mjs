// Run lightweight database reads to help keep the Supabase Free project active.
export default async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_API_KEY;

  if (!url || !key) {
    throw new Error('Supabase keep-alive configuration is missing');
  }

  const response = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/classes?select=id&limit=1`,
    {
      headers: { apikey: key },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase keep-alive failed (HTTP ${response.status})`);
  }

  console.log('Supabase keep-alive succeeded');
};

export const config = {
  schedule: '0 0,8,16 * * *',
};

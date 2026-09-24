let input = '';
for await (const chunk of process.stdin) input += chunk;
const line = input.split(/\r?\n/).find((candidate) => candidate.startsWith('DB_URL='));

if (!line) {
  console.error('SUPABASE DB URL EXPORT FAILED: DB_URL is missing from supabase status output');
  process.exit(1);
}

const value = line.slice('DB_URL='.length).trim();
let connectionString = value;
if (value.startsWith('"')) {
  try {
    connectionString = JSON.parse(value);
  } catch {
    console.error('SUPABASE DB URL EXPORT FAILED: DB_URL is not valid quoted output');
    process.exit(1);
  }
}

try {
  const url = new URL(connectionString);
  url.hostname = '127.0.0.1';
  process.stdout.write(`SUPABASE_DB_URL=${url.toString()}\n`);
} catch {
  console.error('SUPABASE DB URL EXPORT FAILED: DB_URL is not a valid URL');
  process.exit(1);
}

import subprocess
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "export-supabase-db-url.mjs"


class SupabaseDbUrlExportTests(unittest.TestCase):
    def run_exporter(self, status_output):
        return subprocess.run(
            ["node", str(SCRIPT)],
            input=status_output,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_normalizes_quoted_docker_hostname_for_host_runner(self):
        result = self.run_exporter(
            'API_URL="http://127.0.0.1:54321"\n'
            'DB_URL="postgresql://postgres:postgres@base:5432/postgres"\n'
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout,
            "SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres\n",
        )

    def test_fails_when_database_url_is_missing(self):
        result = self.run_exporter('API_URL="http://127.0.0.1:54321"\n')

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DB_URL is missing", result.stderr)


if __name__ == "__main__":
    unittest.main()

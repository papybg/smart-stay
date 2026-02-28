import { neon } from '@neondatabase/serverless';

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.log('no DATABASE_URL');
        return;
    }
    const sql = neon(url);
    const rows = await sql`SELECT id,is_on,source,timestamp FROM power_history ORDER BY timestamp DESC LIMIT 10`;
    console.log(rows);
}

main().catch(e=>{console.error(e);process.exit(1);});

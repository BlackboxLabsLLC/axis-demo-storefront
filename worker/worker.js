import { createServer } from 'node:http';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('DATABASE_URL is required. Connect this worker to a Postgres database.');
	process.exit(1);
}

const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
let processed = 0;
let lastRunAt = null;
let stopping = false;

/**
 * Move one order a step forward. `for update skip locked` lets several worker copies share the
 * queue without handling the same order twice.
 */
async function advance(from, to, message) {
	const client = await db.connect();
	try {
		await client.query('begin');
		const {
			rows: [order],
		} = await client.query(
			`select id from orders where status = $1 and updated_at < now() - interval '3 seconds'
			 order by created_at limit 1 for update skip locked`,
			[from],
		);
		if (!order) {
			await client.query('rollback');
			return false;
		}
		await client.query('update orders set status = $2, updated_at = now() where id = $1', [
			order.id,
			to,
		]);
		await client.query('insert into order_events (order_id, message) values ($1, $2)', [
			order.id,
			message,
		]);
		await client.query('commit');
		processed += 1;
		console.log(`order ${order.id}: ${from} -> ${to}`);
		return true;
	} catch (error) {
		await client.query('rollback').catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

async function tick() {
	lastRunAt = new Date();
	try {
		while (!stopping && (await advance('paid', 'packing', 'Packing your order'))) {}
		while (!stopping && (await advance('packing', 'shipped', 'Shipped with tracking AX-DEMO'))) {}
	} catch (error) {
		// The API creates the schema; until it has, there is nothing to do.
		if (error.code === '42P01') console.log('waiting for the orders table');
		else console.error('worker tick failed:', error.message);
	}
}

// A tiny status endpoint so the platform can health-check the worker.
const port = Number(process.env.PORT ?? 0);
if (port) {
	createServer((request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ ok: true, processed, lastRunAt }));
	}).listen(port, '0.0.0.0');
}

console.log(`order worker started, polling every ${INTERVAL_MS}ms`);
await tick();
const timer = setInterval(tick, INTERVAL_MS);

for (const signal of ['SIGTERM', 'SIGINT']) {
	process.on(signal, async () => {
		stopping = true;
		clearInterval(timer);
		await db.end();
		process.exit(0);
	});
}

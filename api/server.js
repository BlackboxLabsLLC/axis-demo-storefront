import { createServer } from 'node:http';
import pg from 'pg';
import { createClient } from 'redis';

const port = Number(process.env.PORT ?? 4000);
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (!databaseUrl) {
	console.error('DATABASE_URL is required. Connect this app to a Postgres database.');
	process.exit(1);
}

const db = new pg.Pool({ connectionString: databaseUrl, max: 10 });
let cache = null;
if (redisUrl) {
	cache = createClient({ url: redisUrl });
	cache.on('error', (error) => console.warn('redis error', error.message));
	await cache.connect().catch((error) => {
		console.warn('redis unavailable, serving without cache:', error.message);
		cache = null;
	});
} else {
	console.warn('REDIS_URL is not set; the catalog will not be cached');
}

const CATALOG = [
	['espresso-beans', 'Espresso beans, 1 kg', 2400, 'Dark roast, chocolate and cherry notes.'],
	['pour-over-kit', 'Pour-over kit', 3900, 'Ceramic dripper, 100 filters, and a glass carafe.'],
	['burr-grinder', 'Burr grinder', 12900, 'Forty grind settings, quiet motor.'],
	['travel-mug', 'Travel mug', 1800, 'Keeps coffee hot for six hours.'],
	['milk-frother', 'Milk frother', 2900, 'Handheld, rechargeable, two speeds.'],
	['decaf-blend', 'Decaf blend, 500 g', 1600, 'Swiss-water processed, caramel finish.'],
];

async function migrate() {
	await db.query(`
		create table if not exists products (
			sku text primary key,
			name text not null,
			price_cents integer not null check (price_cents > 0),
			description text not null,
			stock integer not null default 100
		);
		create table if not exists orders (
			id bigserial primary key,
			email text not null,
			status text not null default 'paid'
				check (status in ('paid', 'packing', 'shipped')),
			total_cents integer not null,
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now()
		);
		create table if not exists order_items (
			order_id bigint not null references orders(id) on delete cascade,
			sku text not null references products(sku),
			quantity integer not null check (quantity > 0),
			price_cents integer not null,
			primary key (order_id, sku)
		);
		create table if not exists order_events (
			id bigserial primary key,
			order_id bigint not null references orders(id) on delete cascade,
			message text not null,
			created_at timestamptz not null default now()
		);
		create index if not exists orders_status_idx on orders (status, created_at);
	`);
	for (const [sku, name, price, description] of CATALOG) {
		await db.query(
			`insert into products (sku, name, price_cents, description)
			 values ($1, $2, $3, $4) on conflict (sku) do nothing`,
			[sku, name, price, description],
		);
	}
}

async function products() {
	const cached = cache ? await cache.get('catalog:v1').catch(() => null) : null;
	if (cached) return { source: 'cache', items: JSON.parse(cached) };
	const { rows } = await db.query(
		'select sku, name, price_cents, description, stock from products order by price_cents',
	);
	if (cache) await cache.set('catalog:v1', JSON.stringify(rows), { EX: 30 }).catch(() => {});
	return { source: 'database', items: rows };
}

async function createOrder(body) {
	const email = String(body?.email ?? '').trim();
	const items = Array.isArray(body?.items) ? body.items : [];
	if (!/^\S+@\S+\.\S+$/.test(email)) return [400, { error: 'A valid email is required.' }];
	if (!items.length) return [400, { error: 'The cart is empty.' }];

	const client = await db.connect();
	try {
		await client.query('begin');
		let total = 0;
		const lines = [];
		for (const item of items) {
			const quantity = Math.max(1, Math.min(10, Number(item.quantity) || 1));
			const { rows } = await client.query(
				'update products set stock = stock - $2 where sku = $1 and stock >= $2 returning price_cents',
				[String(item.sku), quantity],
			);
			if (!rows[0]) throw Object.assign(new Error(`${item.sku} is out of stock`), { status: 409 });
			total += rows[0].price_cents * quantity;
			lines.push([String(item.sku), quantity, rows[0].price_cents]);
		}
		const {
			rows: [order],
		} = await client.query(
			'insert into orders (email, total_cents) values ($1, $2) returning id, status, total_cents, created_at',
			[email, total],
		);
		for (const [sku, quantity, price] of lines) {
			await client.query(
				'insert into order_items (order_id, sku, quantity, price_cents) values ($1, $2, $3, $4)',
				[order.id, sku, quantity, price],
			);
		}
		await client.query('insert into order_events (order_id, message) values ($1, $2)', [
			order.id,
			'Payment received',
		]);
		await client.query('commit');
		if (cache) await cache.del('catalog:v1').catch(() => {});
		return [201, order];
	} catch (error) {
		await client.query('rollback');
		if (error.status) return [error.status, { error: error.message }];
		throw error;
	} finally {
		client.release();
	}
}

async function order(id) {
	const {
		rows: [row],
	} = await db.query('select id, email, status, total_cents, created_at from orders where id = $1', [
		id,
	]);
	if (!row) return null;
	const [{ rows: items }, { rows: events }] = await Promise.all([
		db.query(
			`select i.sku, p.name, i.quantity, i.price_cents from order_items i
			 join products p on p.sku = i.sku where i.order_id = $1 order by p.name`,
			[id],
		),
		db.query('select message, created_at from order_events where order_id = $1 order by id', [id]),
	]);
	return { ...row, items, events };
}

function send(response, status, body) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

async function readJson(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
	} catch {
		return null;
	}
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', 'http://localhost');
	const started = Date.now();
	try {
		if (request.method === 'GET' && url.pathname === '/health') {
			await db.query('select 1');
			return send(response, 200, { ok: true, cache: Boolean(cache?.isReady) });
		}
		if (request.method === 'GET' && url.pathname === '/products') {
			return send(response, 200, await products());
		}
		if (request.method === 'POST' && url.pathname === '/orders') {
			const body = await readJson(request);
			if (!body) return send(response, 400, { error: 'Invalid JSON.' });
			const [status, result] = await createOrder(body);
			return send(response, status, result);
		}
		const match = url.pathname.match(/^\/orders\/(\d+)$/);
		if (request.method === 'GET' && match) {
			const result = await order(match[1]);
			return result ? send(response, 200, result) : send(response, 404, { error: 'Not found.' });
		}
		if (request.method === 'GET' && url.pathname === '/stats') {
			const { rows } = await db.query(
				'select status, count(*)::int as count from orders group by status order by status',
			);
			return send(response, 200, { orders: rows });
		}
		return send(response, 404, { error: 'Not found.' });
	} catch (error) {
		console.error(`${request.method} ${url.pathname} failed:`, error);
		return send(response, 500, { error: 'Something went wrong.' });
	} finally {
		console.log(`${request.method} ${url.pathname} ${response.statusCode} ${Date.now() - started}ms`);
	}
});

await migrate();
server.listen(port, '0.0.0.0', () => console.log(`storefront api listening on :${port}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
	process.on(signal, () => {
		server.close(async () => {
			await db.end();
			await cache?.quit().catch(() => {});
			process.exit(0);
		});
	});
}

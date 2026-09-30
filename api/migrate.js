// Schema migrations. On Axis, runtime credentials cannot create tables: migrations run through a
// separate `migration@1` connection that assumes the database's stable owner role, so the
// runtime role's default privileges cover everything the migration creates.
import pg from 'pg';

const CATALOG = [
	['espresso-beans', 'Espresso beans, 1 kg', 2400, 'Dark roast, chocolate and cherry notes.'],
	['pour-over-kit', 'Pour-over kit', 3900, 'Ceramic dripper, 100 filters, and a glass carafe.'],
	['burr-grinder', 'Burr grinder', 12900, 'Forty grind settings, quiet motor.'],
	['travel-mug', 'Travel mug', 1800, 'Keeps coffee hot for six hours.'],
	['milk-frother', 'Milk frother', 2900, 'Handheld, rechargeable, two speeds.'],
	['decaf-blend', 'Decaf blend, 500 g', 1600, 'Swiss-water processed, caramel finish.'],
];

/** The owner role Axis creates for a database; `axo_` + first 24 alphanumerics of its id. */
async function ownerRole(client) {
	const { rows } = await client.query(
		`select r.rolname from pg_auth_members m
		 join pg_roles r on r.oid = m.roleid
		 join pg_roles me on me.oid = m.member
		 where me.rolname = current_user and r.rolname like 'axo\\_%'`,
	);
	return rows[0]?.rolname ?? null;
}

export async function migrate(connectionString) {
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		const owner = await ownerRole(client);
		if (owner) await client.query(`set role "${owner.replace(/"/g, '""')}"`);
		await client.query('begin');
		await client.query(`
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
			await client.query(
				`insert into products (sku, name, price_cents, description)
				 values ($1, $2, $3, $4) on conflict (sku) do nothing`,
				[sku, name, price, description],
			);
		}
		await client.query('commit');
		console.log(`schema is up to date${owner ? ` (as ${owner})` : ''}`);
	} catch (error) {
		await client.query('rollback').catch(() => {});
		throw error;
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
		process.exit(1);
	}
	await migrate(url);
}

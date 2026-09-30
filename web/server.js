import { createServer } from 'node:http';
import { hostname } from 'node:os';

const port = Number(process.env.PORT ?? 3000);
const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const shopName = process.env.SHOP_NAME ?? 'Axis Coffee Co.';

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const escape = (value) =>
	String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, init) {
	const response = await fetch(`${apiUrl}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
		signal: AbortSignal.timeout(5000),
	});
	const body = await response.json().catch(() => ({}));
	return { status: response.status, body };
}

function page(title, body) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(shopName)}</title>
<style>
	:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
	body { max-width: 880px; margin: 0 auto; padding: 24px; line-height: 1.5; }
	header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; }
	header a { color: inherit; text-decoration: none; font-weight: 700; font-size: 1.25rem; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
	.card { border: 1px solid color-mix(in oklab, currentColor 15%, transparent); border-radius: 12px; padding: 16px; }
	.card h2 { font-size: 1rem; margin: 0 0 4px; }
	.muted { opacity: 0.65; font-size: 0.875rem; }
	.price { font-weight: 700; margin: 8px 0; }
	button, input { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); }
	button { cursor: pointer; background: #1c1917; color: #fafaf9; border: 0; }
	table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 0; }
	.status { display: inline-block; padding: 2px 10px; border-radius: 999px; background: color-mix(in oklab, currentColor 10%, transparent); }
	footer { margin-top: 40px; }
</style>
</head>
<body>
<header><a href="/">${escape(shopName)}</a><span class="muted">served by ${escape(hostname())}</span></header>
${body}
<footer class="muted">Demo storefront running on Axis.</footer>
</body>
</html>`;
}

async function home() {
	const { status, body } = await api('/products');
	if (status !== 200) return [502, page('Unavailable', '<p>The shop is temporarily unavailable.</p>')];
	const cards = body.items
		.map(
			(p) => `<form class="card" method="post" action="/checkout">
	<h2>${escape(p.name)}</h2>
	<div class="muted">${escape(p.description)}</div>
	<div class="price">${money(p.price_cents)}</div>
	<div class="muted">${p.stock} in stock</div>
	<input type="hidden" name="sku" value="${escape(p.sku)}">
	<p><input name="email" type="email" required placeholder="you@example.com"></p>
	<button>Buy now</button>
</form>`,
		)
		.join('\n');
	return [200, page('Shop', `<p class="muted">Catalog loaded from the ${escape(body.source)}.</p><div class="grid">${cards}</div>`)];
}

async function checkout(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
	const { status, body } = await api('/orders', {
		method: 'POST',
		body: JSON.stringify({ email: form.get('email'), items: [{ sku: form.get('sku'), quantity: 1 }] }),
	});
	if (status !== 201) return [status, page('Checkout failed', `<p>${escape(body.error ?? 'Checkout failed.')}</p><p><a href="/">Back to the shop</a></p>`)];
	return [303, null, { location: `/orders/${body.id}` }];
}

async function orderPage(id) {
	const { status, body } = await api(`/orders/${id}`);
	if (status === 404) return [404, page('Not found', '<p>That order does not exist.</p>')];
	if (status !== 200) return [502, page('Unavailable', '<p>Order lookup failed.</p>')];
	const items = body.items
		.map((i) => `<tr><td>${escape(i.name)}</td><td>${i.quantity}</td><td>${money(i.price_cents * i.quantity)}</td></tr>`)
		.join('');
	const events = body.events
		.map((e) => `<li>${escape(e.message)} <span class="muted">${new Date(e.created_at).toLocaleString()}</span></li>`)
		.join('');
	return [
		200,
		page(
			`Order ${body.id}`,
			`<h1>Order #${body.id} <span class="status">${escape(body.status)}</span></h1>
<p class="muted">${escape(body.email)} · total ${money(body.total_cents)}</p>
<table><tr><th>Item</th><th>Qty</th><th>Price</th></tr>${items}</table>
<h2>Progress</h2><ul>${events}</ul>
<p class="muted">This page refreshes every few seconds while the order worker processes it.</p>
${body.status === 'shipped' ? '' : '<meta http-equiv="refresh" content="4">'}
<p><a href="/">Keep shopping</a></p>`,
		),
	];
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', 'http://localhost');
	const started = Date.now();
	let result;
	try {
		if (url.pathname === '/health') result = [200, 'ok'];
		else if (request.method === 'GET' && url.pathname === '/') result = await home();
		else if (request.method === 'POST' && url.pathname === '/checkout') result = await checkout(request);
		else if (request.method === 'GET' && /^\/orders\/\d+$/.test(url.pathname))
			result = await orderPage(url.pathname.split('/')[2]);
		else result = [404, page('Not found', '<p>Page not found.</p>')];
	} catch (error) {
		console.error(`${request.method} ${url.pathname} failed:`, error.message);
		result = [502, page('Unavailable', '<p>The shop could not reach its API.</p>')];
	}
	const [status, html, headers] = result;
	response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
	response.end(html ?? '');
	console.log(`${request.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
});

server.listen(port, '0.0.0.0', () => console.log(`storefront web listening on :${port}, api ${apiUrl}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

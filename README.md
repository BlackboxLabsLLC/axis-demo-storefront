# Axis demo storefront

A small but real three-service shop used to exercise Axis end to end. Each service is its own
deployable folder with its own `package.json`, the way a typical small team would lay it out.

| Service | Folder | What it does | Talks to |
| --- | --- | --- | --- |
| Storefront | `web/` | Server-rendered shop pages: product list, cart, checkout, order status | `api` over HTTP (`API_URL`) |
| API | `api/` | JSON API for products and orders; caches the catalog in Redis | Postgres (`DATABASE_URL`), Redis (`REDIS_URL`) |
| Order worker | `worker/` | Picks up paid orders, "fulfils" them, records shipping events | Postgres (`DATABASE_URL`) |

The API creates its schema and seeds a catalog on first start, so a fresh database works without a
manual migration step.

## Environment

- `PORT` is provided by the platform.
- `DATABASE_URL`, `REDIS_URL` come from Axis connections to Postgres and Redis.
- `API_URL` points the storefront at the API's private address.

## Run locally

```sh
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:18
docker run -d -p 6379:6379 redis:8
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres REDIS_URL=redis://localhost:6379 PORT=4000 npm start --prefix api
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres npm start --prefix worker
API_URL=http://localhost:4000 PORT=3000 npm start --prefix web
```

# Avaco RunSite Relay

A lightweight Node.js HTTP relay for RunSite.

The service forwards client traffic from a public path to a private upstream server while preserving the same behavior as the original relay:

- path mapping from `PUBLIC_RELAY_PATH` to `RELAY_PATH`
- optional `x-relay-key` authentication
- `GET`, `HEAD`, and `POST` support
- streaming request and response bodies
- upstream timeout control
- concurrent request limiting
- `/__debug` status endpoint

## RunSite deployment

Create a **Web Service** on RunSite and connect this repository.

Use these commands:

```text
Build command: npm install && npm run build
Start command: npm start
```

Set the service port to:

```text
3000
```

Set these environment variables:

```text
TARGET_DOMAIN=https://YOUR-SERVER:PORT
PUBLIC_RELAY_PATH=/api
RELAY_PATH=/api
RELAY_KEY=your-secret-key-min-16-chars
UPSTREAM_TIMEOUT_MS=0
MAX_INFLIGHT=512
PORT=3000
```

If you choose a different service port in RunSite, set `PORT` to that same value.

After deployment, check:

```text
https://YOUR-RUNSITE-URL/__debug
```

## Local test

```bash
npm start
```

Then check:

```bash
curl http://localhost:3000/__debug
```

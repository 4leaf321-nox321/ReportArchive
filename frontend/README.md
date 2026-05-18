# Frontend (React + Vite)

React 18 + Vite 5. Designed to run independently from the backend, but
its build (`dist/`) can also be served directly by the FastAPI backend
without any code changes.

## Layout

```
frontend/
├── src/
│   ├── main.jsx
│   ├── App.jsx                  # Router + chrome
│   ├── App.css / index.css
│   ├── pages/
│   │   └── MainPage.jsx
│   ├── modules/
│   │   └── reports/             # example module
│   │       ├── ReportsPage.jsx
│   │       └── api.js
│   ├── shared/
│   │   ├── api/client.js        # axios instance + envelope helper
│   │   ├── components/
│   │   ├── hooks/
│   │   └── utils/
│   ├── routes/  styles/  utils/
├── public/
├── index.html
├── vite.config.js
├── .env.example / .env.development / .env.production
└── package.json
```

## Quick start

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

## Connecting to the backend

The API client (`src/shared/api/client.js`) reads `VITE_API_BASE_URL`:

| Scenario | `VITE_API_BASE_URL` | How requests get to the backend |
| --- | --- | --- |
| Dev | empty | Vite proxies `/api/*` to `VITE_API_PROXY_TARGET` (default `http://localhost:3000`). |
| Combined deploy | empty | Backend serves the build, so `/api/*` is on the same origin. |
| Independent deploy | `https://api.example.com` | Frontend calls the backend host directly (CORS must be open on the backend). |

## Build

```bash
npm run build        # outputs to dist/
npm run preview      # serve dist/ locally for smoke testing
```

## Adding a new module

1. Copy `src/modules/reports/` → `src/modules/<your-module>/`
2. Add a route in `src/App.jsx`
3. Add an API helper file similar to `src/modules/reports/api.js`

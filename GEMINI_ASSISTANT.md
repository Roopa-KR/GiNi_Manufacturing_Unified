# GiNi Assistant (Google Gemini chatbot)

A chat button (bottom-right) in both the **admin app** and the **operator app**. It answers questions using the same
live, permission-filtered plant data the signed-in user sees (overview, alerts, order forecasts, the user's own task and
queue, and whatever tank / work centre / order is open on screen). It is read-only: it explains and guides, it never
changes anything.

## Enable it

1. Get a key at <https://aistudio.google.com/apikey>.
2. Add it to **`backend/.env`** (the API's file, not the Vite apps):

   ```
   GEMINI_API_KEY=your-key-here
   ```

3. Restart the API (`gini-3-start.ps1`, or `npm run dev:api`). Nothing to change in `admin/` or `frontend/`.

Optional settings (defaults shown): `GEMINI_MODEL=gemini-2.5-flash`, `GEMINI_TEMPERATURE=0.3`,
`GEMINI_TIMEOUT_MS=25000`, `ASSISTANT_RATE_PER_MIN=20`. Without a key the chat panel shows how to enable it.

For Vercel, add `GEMINI_API_KEY` to the **API project's** environment variables. Never put the key in a `VITE_`
variable - those are public in the browser bundle.

## How it works

`admin|frontend/src/components/Assistant.jsx` → `POST /api/assistant/chat` (signed-in users only, CSRF-protected) →
`backend/src/services/assistant.js` builds the context and calls Gemini `generateContent` → reply shown in the panel.
`GET /api/assistant/status` tells the panel whether a key is configured (the key itself is never returned).

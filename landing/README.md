# Landing page

Static, single file, zero external requests. Deploy anywhere.

## Before it goes live

1. **Create a Stripe Payment Link** — Stripe dashboard → Payment Links → new,
   one-time, $1. Copy the URL.
2. Replace `STRIPE_PAYMENT_LINK_HERE` in `index.html` with it. Checkout is
   hosted by Stripe; no card details ever touch this page and none are stored.
3. Deploy, then point kronagent.dev at it.

## Deploy

```bash
npx vercel --prod            # or: firebase deploy --only hosting
```

Then in Spaceship DNS for kronagent.dev: delete the URL-forwarding record that
currently 301s to kronagent.com, and add the record the host gives you.

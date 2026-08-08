# merlinclips.com

Four static pages, one stylesheet, zero external requests — no fonts, no
analytics, no CDN. Nothing we do not control can slow it down or block it.

    /                  the pitch, the incident, the $1 claim
    /architecture      where the decision lives, and what breaks at scale
    /security          threat model, attacks in scope, the invariants
    /testing           property tests, deterministic simulation, defects found

> **Stale as of 5 Aug 2026.** These four pages still describe the previous
> product — a hard spend limit for AI agents. The repo now builds a creator
> campaign payout agent (see the root README). The pages need rewriting before
> the site goes live, or the site and the code will describe different
> products.

## Before it goes live

1. **Create a Polar product** — one-time, $1. Polar is a merchant of record:
   they are the legal seller, handle global tax, and pay out. This matters
   because Stripe India is invite-only and restricted to registered
   businesses; individuals cannot accept international payments at all.
2. Replace `POLAR_CHECKOUT_LINK_HERE` in `index.html` with the checkout URL.
3. Deploy, point merlinclips.com at it, **then click the button yourself before
   posting anywhere.** A dead checkout on the one post that gets traction is
   not recoverable.

## Deploy

```bash
npx vercel --prod
```

Then in Spaceship DNS for merlinclips.com: delete the URL-forwarding record that
currently 301s to merlinclips.com, and add the records Vercel gives you. `.dev`
is on the HSTS preload list, so there is no http fallback — wait for the
certificate to issue before sharing the link.

# Slevy poblíž

PWA, která zobrazuje slevové vouchery na mapě a upozorní tě, když jsi blízko
podniku s aktivní nabídkou.

## Architektura (po nasazení 2026-06-29)

Běží na stejné infrastruktuře jako `czech-businesses` a `closing-line`:

- **Supabase projekt "Czech"** (`uzenopkyiwxdrpyddpjz`) - stejný projekt jako
  ARES/ISIR pipeline, nové tabulky s prefixem `slevy_`, žádný nový projekt,
  žádné extra náklady.
- **3 Supabase Edge Functions** (nasazené, běží):
  - `sync-slevomat-feed` - denně přes `pg_cron` (6:00 UTC), stáhne a uloží
    nabídky. Dokud `slevy_config.slevomat_feed_url` není vyplněné, jen
    potvrdí, že mock data zůstávají.
  - `check-proximity-and-notify` - každých 10 minut přes `pg_cron`. Pro
    každý uložený push subscription s nedávno nahlášenou polohou zkontroluje
    vzdálenost ke všem podnikům a pošle Web Push, když je do 350 m
    (`slevy_config.alert_radius_m`). Debounce 10 min na podnik.
  - `send-test-push` - voláno tlačítkem "Testovací push" v appce, pošle
    okamžitě testovací notifikaci všem uloženým subscriptions.
- **`pg_cron` + `pg_net`** - obě úlohy běží automaticky, navěky, zdarma,
  bez jakékoli manuální akce. Lze zkontrolovat: `select * from cron.job
  where jobname like 'slevy-%';` a historii běhů v `slevy_function_runs`.
- **Next.js PWA** - čistě statická appka (žádné Vercel serverless funkce),
  mluví přímo se Supabase (anon klíč, RLS). Deploy na Vercel projekt ve
  stejném týmu (`lewros-projects`) jako `czech-businesses`/`closing-line`.

### Tabulky v Supabase

- `slevy_venues` - podniky + nabídky (5 mock řádků z Prahy, čeká na reálný feed)
- `slevy_push_subscriptions` - push subscriptions + poslední nahlášená poloha
- `slevy_config` - VAPID klíče, feed URL, radius - **bez RLS policy, čte jen
  service_role** (edge functions), takže nikdy není veřejně čitelné
- `slevy_function_runs` - log běhů cron funkcí, pro debug

## Co zbývá doplnit

### Reálný Slevomat feed

Až budeš mít affiliate XML feed z `doporuc.slevomat.cz`, pošli mi URL a já:

1. Uložím ho do `slevy_config.slevomat_feed_url` (jedna SQL příkaz, hned živé)
2. Doplním `parseSlevomatXml()` uvnitř `sync-slevomat-feed` podle reálné
   struktury feedu (teď je tam jen placeholder, který vrací prázdné pole)

Jakmile je oboje hotovo, denní cron začne sám aktualizovat `slevy_venues`
reálnými daty - bez dalšího zásahu.

## Technické omezení (čti před testováním)

Web platforma neumí spolehlivý background geofencing - Geolocation API není
dostupné uvnitř service workeru:

- **Appka otevřená/na popředí** → spolehlivé, real-time (watchPosition + lokální notifikace)
- **Server-side kontrola (pg_cron, vše OS/platformy)** → běží automaticky
  každých 10 min, ale jen na základě poslední polohy, kterou appka nahlásila,
  když byla otevřená - není to nezávislý geofencing
- **iOS appka zavřená** → v podstatě nic, Apple ukončuje JS appek na pozadí

Pro skutečně spolehlivé upozornění i se zavřenou appkou na obou platformách
by bylo potřeba tenký nativní wrapper (např. Flutter + nativní geofencing
plugin) kolem stejných dat.

## Nasazení na Vercel

```bash
npm install
npx vercel login
npx vercel --prod
```

Po prvním nasazení ve Vercel dashboardu → Settings → Environment Variables
nastav (hodnoty jsou v `.env.local`):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`

Redeploy a otevři URL na telefonu → "Přidat na plochu".

## Lokální vývoj

```bash
npm run dev
```

import { supabase, SUPABASE_FUNCTIONS_URL } from "./supabase";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function upsertSubscriptionRow(fields) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  const json = sub.toJSON();
  await supabase.from("slevy_push_subscriptions").upsert(
    {
      endpoint: sub.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      updated_at: new Date().toISOString(),
      ...fields,
    },
    { onConflict: "endpoint" }
  );
}

export async function enableNotifications() {
  if (!("Notification" in window)) {
    throw new Error("Tento prohlížeč nepodporuje notifikace.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifikace nebyly povoleny.");
  }

  const reg = await navigator.serviceWorker.ready;

  // Best-effort periodic background sync (Chrome/Android only). The real
  // automatic checking now happens server-side via Supabase pg_cron every
  // ~10 min regardless of whether this registers - this is just an extra
  // best-effort nudge while the device is online and the criteria are met.
  try {
    if ("periodicSync" in reg) {
      await reg.periodicSync.register("check-nearby-deals", { minInterval: 60 * 60 * 1000 });
    }
  } catch (e) {
    // not supported / criteria not met - fine, server cron covers this
  }

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey || !("pushManager" in reg)) {
    return { push: false };
  }

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  await upsertSubscriptionRow({});
  return { push: true };
}

export async function showLocalNotification(title, options) {
  const reg = await navigator.serviceWorker.ready;
  return reg.showNotification(title, options);
}

export async function reportLocation(lat, lng) {
  try {
    await upsertSubscriptionRow({ last_lat: lat, last_lng: lng });
  } catch (e) {
    // best effort - if no subscription exists yet, there's nothing to update
  }
}

export async function sendTestPush() {
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/send-test-push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

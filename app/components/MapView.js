"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import { distanceMeters, formatDistance } from "../../lib/geo";
import { enableNotifications, showLocalNotification, reportLocation, sendTestPush } from "../../lib/push-client";
import { supabase } from "../../lib/supabase";

const ALERT_RADIUS_M = 350;
const ALERT_DEBOUNCE_MS = 10 * 60 * 1000;
const LOCATION_REPORT_THROTTLE_MS = 30 * 1000;
const SITE_URL = "https://slevy-poblizu-v1dt.vercel.app/";

// Build affiliate URL per Slevomat UTM spec
function affiliateUrl(venue) {
  const base = venue.url || "";
  if (!base) return "#";
  const country = venue.source === "slevomat-sk" ? "svk" : "cze";
  const campaign = `dis_akv_gen_${country}_all_buy_romanlein_${encodeURIComponent(SITE_URL)}`;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}utm_source=affiliate&utm_medium=cpc&utm_campaign=${campaign}&utm_term=romanlein`;
}

export default function MapView() {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);
  const accuracyCircleRef = useRef(null);
  const markersRef = useRef({});
  const lastAlertedRef = useRef({});
  const lastReportRef = useRef(0);

  const [venues, setVenues] = useState([]);
  const [tracking, setTracking] = useState(false);
  const [nearbyVenue, setNearbyVenue] = useState(null);
  const [toast, setToast] = useState(null);
  const [notifEnabled, setNotifEnabled] = useState(false);

  const flashToast = useCallback((msg, ms = 3200) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), ms);
  }, []);

  useEffect(() => {
    let map;
    (async () => {
      const L = (await import("leaflet")).default;
      delete L.Icon.Default.prototype._getIconUrl;

      map = L.map(mapElRef.current, { zoomControl: true, attributionControl: true })
        .setView([50.0784, 14.4424], 12);

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;

      const { data, error } = await supabase.from("slevy_venues").select("*");
      if (!error) setVenues(data || []);
    })();

    return () => { if (map) map.remove(); };
  }, []);

  useEffect(() => {
    if (!mapRef.current || venues.length === 0) return;
    (async () => {
      const L = (await import("leaflet")).default;

      for (const v of venues) {
        if (markersRef.current[v.id]) continue;
        const pct = v.discount_pct ?? "?";
        const icon = L.divIcon({
          className: "",
          html: `<div class="venue-pin" id="pin-${v.id}"><span>${pct}%</span></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 28],
          popupAnchor: [0, -26],
        });
        const marker = L.marker([v.lat, v.lng], { icon }).addTo(mapRef.current);

        const affUrl = affiliateUrl(v);
        const priceStr = v.price
          ? `${v.price} Kč${v.original_price ? ` <s style="opacity:.5">${v.original_price} Kč</s>` : ""}`
          : "";
        const validStr = v.valid_until ? `<br/><span style="opacity:.5;font-size:11px">Platí do ${v.valid_until}</span>` : "";

        marker.bindPopup(`
          <b style="font-size:13px;line-height:1.3">${v.name}</b>
          <br/><span style="opacity:.75;font-size:12px">${v.address || ""}</span>
          <br/><span style="font-size:12px">${v.offer || ""}</span>
          <br/>${priceStr}${validStr}
          <br/><a href="${affUrl}" target="_blank" rel="noopener"
            style="display:inline-block;margin-top:8px;padding:6px 12px;background:#e8732c;color:#1a1812;
            border-radius:8px;font-weight:700;font-size:12px;text-decoration:none">
            Koupit na Slevomatu →
          </a>
        `, { maxWidth: 260 });

        markersRef.current[v.id] = marker;
      }
    })();
  }, [venues]);

  const markPinInRange = useCallback((venueId, inRange) => {
    const el = document.getElementById(`pin-${venueId}`);
    if (el) el.classList.toggle("in-range", inRange);
  }, []);

  const handlePosition = useCallback(async (pos) => {
    const { latitude, longitude, accuracy } = pos.coords;

    if (mapRef.current) {
      const L = (await import("leaflet")).default;
      if (!userMarkerRef.current) {
        const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [16, 16] });
        userMarkerRef.current = L.marker([latitude, longitude], { icon, zIndexOffset: 1000 }).addTo(mapRef.current);
        accuracyCircleRef.current = L.circle([latitude, longitude], {
          radius: accuracy, color: "#5b9cf0", weight: 1, fillOpacity: 0.08,
        }).addTo(mapRef.current);
      } else {
        userMarkerRef.current.setLatLng([latitude, longitude]);
        accuracyCircleRef.current.setLatLng([latitude, longitude]).setRadius(accuracy);
      }
    }

    const now = Date.now();
    if (now - lastReportRef.current > LOCATION_REPORT_THROTTLE_MS) {
      lastReportRef.current = now;
      reportLocation(latitude, longitude);
    }

    let closest = null;
    for (const v of venues) {
      const d = distanceMeters(latitude, longitude, v.lat, v.lng);
      markPinInRange(v.id, d <= ALERT_RADIUS_M);
      if (d <= ALERT_RADIUS_M && (!closest || d < closest.distance)) {
        closest = { ...v, distance: d };
      }
    }

    setNearbyVenue(closest);

    if (closest) {
      const lastAlert = lastAlertedRef.current[closest.id] || 0;
      if (now - lastAlert > ALERT_DEBOUNCE_MS) {
        lastAlertedRef.current[closest.id] = now;
        try {
          await showLocalNotification(`Sleva poblíž: ${closest.name}`, {
            body: `${closest.offer} · ${Math.round(closest.distance)} m od vás`,
            icon: "/icons/icon-192.png",
            tag: closest.id,
            data: { url: affiliateUrl(closest) },
          });
        } catch (e) { /* notification permission not granted */ }
      }
    }
  }, [venues, markPinInRange]);

  useEffect(() => {
    if (!("geolocation" in navigator) || venues.length === 0) return;
    setTracking(true);
    const watchId = navigator.geolocation.watchPosition(handlePosition, () => setTracking(false), {
      enableHighAccuracy: true, maximumAge: 5000, timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [venues, handlePosition]);

  async function onEnableNotifications() {
    try {
      const result = await enableNotifications();
      setNotifEnabled(true);
      flashToast(result.push ? "Upozornění povolena a push zapojen." : "Upozornění povolena.");
    } catch (e) {
      flashToast(e.message || "Nepodařilo se povolit upozornění.");
    }
  }

  async function onSendTestPush() {
    try {
      const data = await sendTestPush();
      if (data.ok) flashToast(`Test push odeslán (${data.sent} doručeno).`);
      else flashToast(data.error || "Test push se nepodařilo odeslat.");
    } catch (e) {
      flashToast("Test push se nepodařilo odeslat.");
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="display">Slevy poblíž</span>
        </div>
        <span className={`status-pill ${tracking ? "live" : ""}`}>
          <span className="dot" />
          {tracking ? "Sleduji polohu" : "Bez polohy"}
        </span>
      </div>

      <div className="map-wrap">
        <div id="map" ref={mapElRef} />
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="bottombar">
        {nearbyVenue && (
          <a
            className="alert-card"
            href={affiliateUrl(nearbyVenue)}
            target="_blank"
            rel="noopener"
            style={{ textDecoration: "none" }}
          >
            <div className="badge">{nearbyVenue.discount_pct ?? "?"}%</div>
            <div className="body">
              <p className="title">{nearbyVenue.name}</p>
              <p className="desc">
                {nearbyVenue.offer} · {formatDistance(nearbyVenue.distance)}
              </p>
            </div>
            <div style={{ fontSize: 18, color: "var(--amber)", flexShrink: 0 }}>→</div>
          </a>
        )}
        <div className="actions-row">
          <button className="btn primary" onClick={onEnableNotifications} disabled={notifEnabled}>
            {notifEnabled ? "Upozornění zapnuta" : "Povolit upozornění"}
          </button>
          <button className="btn" onClick={onSendTestPush}>
            Testovací push
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import { distanceMeters, formatDistance } from "../../lib/geo";
import { enableNotifications, showLocalNotification, reportLocation, sendTestPush } from "../../lib/push-client";
import { supabase } from "../../lib/supabase";

const ALERT_RADIUS_M = 350;
const ALERT_DEBOUNCE_MS = 10 * 60 * 1000; // don't re-alert the same venue for 10 min
const LOCATION_REPORT_THROTTLE_MS = 30 * 1000;

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

  // Init map once
  useEffect(() => {
    let map;
    (async () => {
      const L = (await import("leaflet")).default;
      delete L.Icon.Default.prototype._getIconUrl;

      map = L.map(mapElRef.current, {
        zoomControl: true,
        attributionControl: true,
      }).setView([50.0784, 14.4424], 14); // Prague default

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;

      const { data, error } = await supabase.from("slevy_venues").select("*");
      if (!error) setVenues(data || []);
    })();

    return () => {
      if (map) map.remove();
    };
  }, []);

  // Render/update venue markers
  useEffect(() => {
    if (!mapRef.current || venues.length === 0) return;
    (async () => {
      const L = (await import("leaflet")).default;

      for (const v of venues) {
        if (markersRef.current[v.id]) continue;
        const icon = L.divIcon({
          className: "",
          html: `<div class="venue-pin" id="pin-${v.id}"><span>${v.discountPct}%</span></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 28],
          popupAnchor: [0, -26],
        });
        const marker = L.marker([v.lat, v.lng], { icon }).addTo(mapRef.current);
        marker.bindPopup(
          `<b>${v.name}</b><br/>${v.offer}<br/>${v.price} Kč <s>${v.originalPrice} Kč</s>`
        );
        markersRef.current[v.id] = marker;
      }
    })();
  }, [venues]);

  const markPinInRange = useCallback((venueId, inRange) => {
    const el = document.getElementById(`pin-${venueId}`);
    if (el) el.classList.toggle("in-range", inRange);
  }, []);

  const handlePosition = useCallback(
    async (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;

      if (mapRef.current) {
        const L = (await import("leaflet")).default;
        if (!userMarkerRef.current) {
          const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [16, 16] });
          userMarkerRef.current = L.marker([latitude, longitude], { icon, zIndexOffset: 1000 }).addTo(mapRef.current);
          accuracyCircleRef.current = L.circle([latitude, longitude], {
            radius: accuracy,
            color: "#5b9cf0",
            weight: 1,
            fillOpacity: 0.08,
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
            });
          } catch (e) {
            // notification permission not granted yet - silent
          }
        }
      }
    },
    [venues, markPinInRange]
  );

  useEffect(() => {
    if (!("geolocation" in navigator) || venues.length === 0) return;
    setTracking(true);
    const watchId = navigator.geolocation.watchPosition(handlePosition, () => setTracking(false), {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
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
          <span className="eyebrow">Prototyp</span>
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
          <div className="alert-card">
            <div className="badge">{nearbyVenue.discountPct}%</div>
            <div className="body">
              <p className="title">{nearbyVenue.name}</p>
              <p className="desc">
                {nearbyVenue.offer} · {formatDistance(nearbyVenue.distance)}
              </p>
            </div>
          </div>
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

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import { distanceMeters, formatDistance } from "../../lib/geo";
import { enableNotifications, showLocalNotification, reportLocation } from "../../lib/push-client";
import { supabase } from "../../lib/supabase";

const ALERT_RADIUS_M = 350;
const ALERT_DEBOUNCE_MS = 10 * 60 * 1000;
const LOCATION_REPORT_THROTTLE_MS = 30 * 1000;
const ZOOM_THRESHOLD = 14;
const SITE_URL = "https://slevy-poblizu-v1dt.vercel.app/";

function affiliateUrl(v) {
  const base = v.url || "";
  if (!base) return "#";
  const cc = v.source === "slevomat-sk" ? "svk" : "cze";
  const campaign = `dis_akv_gen_${cc}_all_buy_romanlein_${encodeURIComponent(SITE_URL)}`;
  return `${base}${base.includes("?") ? "&" : "?"}utm_source=affiliate&utm_medium=cpc&utm_campaign=${campaign}&utm_term=romanlein`;
}

function calcPct(price, original) {
  if (!price || !original || original <= 0) return null;
  return Math.round(((original - price) / original) * 100);
}

function buildPopupHtml(v) {
  const pct = v.discount_pct ?? calcPct(v.price, v.original_price);
  const priceHtml = v.price
    ? `<div style="margin-bottom:14px">
        <span style="font-size:16px;font-weight:700;color:#000">${v.price} Kč</span>
        ${v.original_price
          ? `&nbsp;<s style="font-size:13px;color:#bbb">${v.original_price} Kč</s>&nbsp;<span style="font-size:13px;font-weight:700;color:#22c55e">-${pct}%</span>`
          : ""}
       </div>` : "";
  const validHtml = v.valid_until
    ? `<div style="font-size:12px;color:#aaa;margin-bottom:14px">Platí do ${v.valid_until}</div>` : "";
  return `<div style="padding:24px;padding-top:28px;min-width:220px;max-width:280px">
    <div style="font-size:16px;font-weight:700;color:#000;line-height:1.35;margin-bottom:6px">${v.name}</div>
    ${v.address ? `<div style="font-size:14px;color:#666;margin-bottom:8px">${v.address}</div>` : ""}
    ${v.offer   ? `<div style="font-size:14px;color:#666;line-height:1.45;margin-bottom:14px">${v.offer}</div>` : ""}
    ${priceHtml}${validHtml}
    <a href="${affiliateUrl(v)}" target="_blank" rel="noopener"
      style="display:block;padding:13px 20px;background:#000;color:#fff;border-radius:100px;
             font-size:14px;font-weight:600;text-decoration:none;text-align:center">
      Koupit na Slevomatu →
    </a>
  </div>`;
}

export default function MapView() {
  const mapElRef          = useRef(null);
  const mapRef            = useRef(null);
  const lRef              = useRef(null);
  const userMarkerRef     = useRef(null);
  const accuracyCircleRef = useRef(null);
  const markersRef        = useRef({});
  const lastAlertedRef    = useRef({});
  const lastReportRef     = useRef(0);
  const venuesRef         = useRef([]);
  const zoomedToUserRef   = useRef(false);
  const selectedCatsRef   = useRef(null); // null = all

  const [tracking,       setTracking]       = useState(false);
  const [nearbyVenue,    setNearbyVenue]    = useState(null);
  const [toast,          setToast]          = useState(null);
  const [notifEnabled,   setNotifEnabled]   = useState(false);
  const [loading,        setLoading]        = useState(false);
  const [showFilter,     setShowFilter]     = useState(false);
  const [allCategories,  setAllCategories]  = useState([]);
  const [pendingCats,    setPendingCats]    = useState(null); // while sheet is open
  const [activeCats,     setActiveCats]     = useState(null); // applied filter (null = all)

  const flashToast = useCallback((msg, ms = 3200) => {
    setToast(msg);
    setTimeout(() => setToast(cur => (cur === msg ? null : cur)), ms);
  }, []);

  // Load distinct categories once
  useEffect(() => {
    supabase.rpc("slevy_distinct_categories").then(({ data }) => {
      if (data) setAllCategories(data);
    });
  }, []);

  // Fetch venues in current viewport + buffer, add markers
  const refreshMarkers = useCallback(async (map, L) => {
    if (!map || !L) return;
    const bounds = map.getBounds().pad(0.4);
    setLoading(true);

    let query = supabase
      .from("slevy_venues")
      .select("id,name,lat,lng,offer,price,original_price,discount_pct,valid_until,url,source,address,category")
      .gte("lat", bounds.getSouth()).lte("lat", bounds.getNorth())
      .gte("lng", bounds.getWest()).lte("lng", bounds.getEast())
      .limit(600);

    if (selectedCatsRef.current) {
      query = query.in("category", selectedCatsRef.current);
    }

    const { data } = await query;
    setLoading(false);
    if (!data) return;

    // Merge into venuesRef for proximity calculations
    const existingIds = new Set(venuesRef.current.map(v => v.id));
    venuesRef.current = [...venuesRef.current, ...data.filter(v => !existingIds.has(v.id))];

    // Add new markers only
    for (const v of data) {
      if (markersRef.current[v.id]) continue;
      const pct = v.discount_pct ?? calcPct(v.price, v.original_price);
      const shortName = v.name?.slice(0, 20) ?? "";
      const icon = L.divIcon({
        className: "",
        html: `<div class="venue-pin" id="pin-${v.id}">
          <div class="pin-label">
            ${pct != null ? `<span class="pin-pct">-${pct}%</span>` : ""}
            <span class="pin-name">${shortName}</span>
          </div>
          <div class="pin-dot"></div>
        </div>`,
        iconSize: [140, 46],
        iconAnchor: [70, 46],
        popupAnchor: [0, -48],
      });
      const marker = L.marker([v.lat, v.lng], { icon }).addTo(map);
      marker.bindPopup(buildPopupHtml(v), { maxWidth: 300, minWidth: 240 });
      markersRef.current[v.id] = marker;
    }
  }, []);

  // Remove all markers and reload with current filter
  const reloadMarkers = useCallback(() => {
    const map = mapRef.current;
    const L   = lRef.current;
    if (!map || !L) return;
    Object.values(markersRef.current).forEach(m => map.removeLayer(m));
    markersRef.current = {};
    venuesRef.current  = [];
    setNearbyVenue(null);
    refreshMarkers(map, L);
  }, [refreshMarkers]);

  // Init map
  useEffect(() => {
    let map;
    (async () => {
      const L = (await import("leaflet")).default;
      delete L.Icon.Default.prototype._getIconUrl;
      lRef.current = L;

      map = L.map(mapElRef.current, { zoomControl: true, attributionControl: true })
              .setView([50.0784, 14.4424], 13);
      mapRef.current = map;

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19,
      }).addTo(map);

      const updateZoomClass = () =>
        map.getContainer().classList.toggle("map-zoomed-in", map.getZoom() >= ZOOM_THRESHOLD);

      map.on("zoomend",  () => { updateZoomClass(); refreshMarkers(map, L); });
      map.on("moveend",  () => refreshMarkers(map, L));

      // Quick initial zoom to user position (low accuracy = faster on mobile)
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          pos => {
            if (!zoomedToUserRef.current) {
              zoomedToUserRef.current = true;
              map.setView([pos.coords.latitude, pos.coords.longitude], 19, { animate: true });
            }
          },
          () => {},
          { timeout: 6000, maximumAge: 120000, enableHighAccuracy: false }
        );
      }

      await refreshMarkers(map, L);
    })();

    return () => { if (map) map.remove(); };
  }, [refreshMarkers]);

  const markPinInRange = useCallback((venueId, inRange) => {
    const el = document.getElementById(`pin-${venueId}`);
    if (el) el.classList.toggle("in-range", inRange);
  }, []);

  const handlePosition = useCallback(async pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    const map = mapRef.current;
    const L   = lRef.current;
    if (!map || !L) return;

    // High-accuracy zoom (from watchPosition, more precise than getCurrentPosition)
    if (!zoomedToUserRef.current) {
      zoomedToUserRef.current = true;
      map.setView([latitude, longitude], 19, { animate: true });
    }

    if (!userMarkerRef.current) {
      const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [16, 16] });
      userMarkerRef.current     = L.marker([latitude, longitude], { icon, zIndexOffset: 1000 }).addTo(map);
      accuracyCircleRef.current = L.circle([latitude, longitude], {
        radius: accuracy, color: "#5b9cf0", weight: 1, fillOpacity: 0.08,
      }).addTo(map);
    } else {
      userMarkerRef.current.setLatLng([latitude, longitude]);
      accuracyCircleRef.current.setLatLng([latitude, longitude]).setRadius(accuracy);
    }

    const now = Date.now();
    if (now - lastReportRef.current > LOCATION_REPORT_THROTTLE_MS) {
      lastReportRef.current = now;
      reportLocation(latitude, longitude);
    }

    let closest = null;
    for (const v of venuesRef.current) {
      const d = distanceMeters(latitude, longitude, v.lat, v.lng);
      markPinInRange(v.id, d <= ALERT_RADIUS_M);
      if (d <= ALERT_RADIUS_M && (!closest || d < closest.distance)) closest = { ...v, distance: d };
    }
    setNearbyVenue(closest);

    if (closest) {
      const lastAlert = lastAlertedRef.current[closest.id] || 0;
      if (now - lastAlert > ALERT_DEBOUNCE_MS) {
        lastAlertedRef.current[closest.id] = now;
        try {
          await showLocalNotification(`Sleva poblíž: ${closest.name}`, {
            body: `${closest.offer} · ${Math.round(closest.distance)} m od vás`,
            icon: "/icons/icon-192.png", tag: closest.id,
            data: { url: affiliateUrl(closest) },
          });
        } catch (e) { /* no permission */ }
      }
    }
  }, [markPinInRange]);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    setTracking(true);
    const watchId = navigator.geolocation.watchPosition(handlePosition, () => setTracking(false), {
      enableHighAccuracy: true, maximumAge: 5000, timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [handlePosition]);

  // --- Filter sheet helpers ---
  const openFilter = () => {
    setPendingCats(activeCats ? new Set(activeCats) : null);
    setShowFilter(true);
  };

  const toggleCat = cat => {
    setPendingCats(prev => {
      // null means all selected — start with all selected, then toggle one off
      const base = prev ?? new Set(allCategories.map(c => c.category));
      const next = new Set(base);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      // if all selected, go back to null (= all)
      return next.size === allCategories.length ? null : next;
    });
  };

  const selectAll = () => setPendingCats(null);

  const applyFilter = () => {
    const cats = pendingCats ? [...pendingCats] : null;
    setActiveCats(cats);
    selectedCatsRef.current = cats;
    setShowFilter(false);
    reloadMarkers();
  };

  const isCatSelected = cat => {
    if (pendingCats === null) return true;
    return pendingCats.has(cat);
  };

  const filterLabel = activeCats
    ? `Filtry ${activeCats.length}/${allCategories.length}`
    : "Filtry";

  async function onEnableNotifications() {
    try {
      const { enableNotifications: en } = await import("../../lib/push-client");
      const result = await en();
      setNotifEnabled(true);
      flashToast(result.push ? "Upozornění povolena." : "Upozornění zapnuta.");
    } catch (e) {
      flashToast(e.message || "Nepodařilo se povolit upozornění.");
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><span className="display">Slevy poblíž</span></div>
        <span className={`status-pill ${tracking ? "live" : ""}`}>
          <span className="dot" />
          {tracking ? "Sleduji polohu" : "Bez polohy"}
        </span>
      </div>

      <div className="map-wrap">
        <div id="map" ref={mapElRef} />
        {loading && <div className="map-loading">Načítám nabídky…</div>}
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="bottombar">
        {nearbyVenue && (
          <a className="alert-card" href={affiliateUrl(nearbyVenue)} target="_blank" rel="noopener">
            <div className="badge">
              {nearbyVenue.discount_pct ?? calcPct(nearbyVenue.price, nearbyVenue.original_price) ?? "?"}%
            </div>
            <div className="body">
              <p className="title">{nearbyVenue.name}</p>
              <p className="desc">{nearbyVenue.offer} · {formatDistance(nearbyVenue.distance)}</p>
            </div>
            <div style={{ fontSize: 18, color: "var(--green)", flexShrink: 0 }}>→</div>
          </a>
        )}
        <div className="actions-row">
          <button className="btn primary" onClick={onEnableNotifications} disabled={notifEnabled}>
            {notifEnabled ? "Upozornění zapnuta ✓" : "Povolit upozornění"}
          </button>
          <button className={`btn filter ${activeCats ? "active" : ""}`} onClick={openFilter}>
            ⊞ {filterLabel}
          </button>
        </div>
      </div>

      {/* Category filter sheet */}
      {showFilter && (
        <div className="filter-overlay" onClick={() => setShowFilter(false)}>
          <div className="filter-sheet" onClick={e => e.stopPropagation()}>
            <div className="filter-handle" />
            <div className="filter-head">
              <h2>Kategorie</h2>
              <button className="filter-close" onClick={() => setShowFilter(false)}>✕</button>
            </div>
            <div className="filter-list">
              {allCategories.map(({ category, cnt }) => (
                <div key={category} className="filter-item" onClick={() => toggleCat(category)}>
                  <div className={`filter-check ${isCatSelected(category) ? "checked" : ""}`} />
                  <span className="filter-label">{category}</span>
                  <span className="filter-count">{cnt}</span>
                </div>
              ))}
            </div>
            <div className="filter-foot">
              <button className="btn-all" onClick={selectAll}>Vybrat vše</button>
              <button className="btn-apply" onClick={applyFilter}>
                Zobrazit {pendingCats ? `${pendingCats.size} kategorií` : "vše"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

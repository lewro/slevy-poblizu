"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import { distanceMeters, formatDistance } from "../../lib/geo";
import { supabase } from "../../lib/supabase";

const ALERT_RADIUS_M = 350;
const ZOOM_THRESHOLD = 14;
const SITE_URL = "https://slevy-poblizu-v1dt.vercel.app/";

// Hardcoded raw values for default restaurant filter (before RPC loads)
const RESTAURANT_RAW = ["Restaurace a bary", "Reštaurácie a bary"];

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
    ? `<div style="margin-bottom:16px">
        <span style="font-size:16px;font-weight:400;color:#000">${v.price} Kč</span>
        ${v.original_price
          ? `&nbsp;<s style="font-size:12px;color:#bbb;font-weight:400">${v.original_price} Kč</s>&nbsp;<span style="font-size:12px;color:#22c55e;font-weight:400">-${pct}%</span>`
          : ""}
      </div>` : "";
  return `<div style="padding:24px 16px;min-width:220px;max-width:280px;padding-top:44px">
    <div style="font-size:16px;font-weight:400;color:#000;line-height:1.35;margin-bottom:6px">${v.name}</div>
    ${v.address ? `<div style="font-size:12px;color:#666;margin-bottom:8px">${v.address}</div>` : ""}
    ${v.offer   ? `<div style="font-size:12px;color:#666;line-height:1.5;margin-bottom:14px">${v.offer}</div>` : ""}
    ${priceHtml}
    <a href="${affiliateUrl(v)}" target="_blank" rel="noopener"
      style="display:block;padding:12px 20px;background:#000;color:#fff;border-radius:100px;
             font-size:12px;font-weight:400;text-decoration:none;text-align:center">
      Koupit na Slevomatu
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
  const venuesRef         = useRef([]);
  const zoomedToUserRef   = useRef(false);
  const selectedRawRef    = useRef(RESTAURANT_RAW); // raw DB values for current filter

  const [tracking,      setTracking]      = useState(false);
  const [nearbyVenue,   setNearbyVenue]   = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [showFilter,    setShowFilter]    = useState(false);
  const [allCategories, setAllCategories] = useState([]);
  const [pendingCats,   setPendingCats]   = useState(new Set(["Restaurace a bary"]));
  const [activeCats,    setActiveCats]    = useState(["Restaurace a bary"]); // normalized names

  // Load categories
  useEffect(() => {
    supabase.rpc("slevy_distinct_categories").then(({ data }) => {
      if (data) setAllCategories(data);
    });
  }, []);

  const today = new Date().toISOString().split("T")[0];

  const refreshMarkers = useCallback(async (map, L) => {
    if (!map || !L) return;
    const bounds = map.getBounds().pad(0.4);
    setLoading(true);

    let query = supabase
      .from("slevy_venues")
      .select("id,name,lat,lng,offer,price,original_price,discount_pct,valid_until,url,source,address,category")
      .gte("lat", bounds.getSouth()).lte("lat", bounds.getNorth())
      .gte("lng", bounds.getWest()).lte("lng", bounds.getEast())
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .limit(600);

    if (selectedRawRef.current) {
      query = query.in("category", selectedRawRef.current);
    }

    const { data } = await query;
    setLoading(false);
    if (!data) return;

    const existingIds = new Set(venuesRef.current.map(v => v.id));
    venuesRef.current = [...venuesRef.current, ...data.filter(v => !existingIds.has(v.id))];

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
        iconSize: [160, 50],
        iconAnchor: [80, 50],
        popupAnchor: [0, -52],
      });
      const marker = L.marker([v.lat, v.lng], { icon }).addTo(map);
      marker.bindPopup(buildPopupHtml(v), { maxWidth: 300, minWidth: 240 });

      // Hide pin-label when popup is open (avoid duplicity)
      marker.on("popupopen", () => {
        const label = document.querySelector(`#pin-${v.id} .pin-label`);
        if (label) label.style.display = "none";
      });
      marker.on("popupclose", () => {
        const label = document.querySelector(`#pin-${v.id} .pin-label`);
        if (label) label.style.display = "";
      });

      markersRef.current[v.id] = marker;
    }
  }, [today]);

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

      // Quick zoom to user (low accuracy = fast cached response)
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

  // Geolocation watch for user dot + proximity card (no notifications)
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    setTracking(true);

    const watchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude, accuracy } = pos.coords;
        const map = mapRef.current;
        const L   = lRef.current;
        if (!map || !L) return;

        if (!zoomedToUserRef.current) {
          zoomedToUserRef.current = true;
          map.setView([latitude, longitude], 19, { animate: true });
        }

        (async () => {
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
        })();

        let closest = null;
        for (const v of venuesRef.current) {
          const d = distanceMeters(latitude, longitude, v.lat, v.lng);
          markPinInRange(v.id, d <= ALERT_RADIUS_M);
          if (d <= ALERT_RADIUS_M && (!closest || d < closest.distance)) closest = { ...v, distance: d };
        }
        setNearbyVenue(closest);
      },
      () => setTracking(false),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [markPinInRange]);

  // ── Filter helpers ──
  const openFilter = () => {
    setPendingCats(activeCats ? new Set(activeCats) : null);
    setShowFilter(true);
  };

  const toggleCat = cat => {
    setPendingCats(prev => {
      const base = prev ?? new Set(allCategories.map(c => c.category));
      const next = new Set(base);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next.size === allCategories.length ? null : next;
    });
  };

  const applyFilter = () => {
    if (!pendingCats) {
      // all selected
      setActiveCats(null);
      selectedRawRef.current = null;
    } else {
      const normArr = [...pendingCats];
      setActiveCats(normArr);
      // expand to raw DB values
      const raw = normArr.flatMap(normCat => {
        const found = allCategories.find(c => c.category === normCat);
        return found?.raw_values ?? [normCat];
      });
      selectedRawRef.current = raw;
    }
    setShowFilter(false);
    reloadMarkers();
  };

  const isCatSelected = cat => pendingCats === null || pendingCats.has(cat);

  const filterLabel = activeCats
    ? `Filtry ${activeCats.length}/${allCategories.length || "…"}`
    : "Filtry";

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><span className="display">Slevy poblíž</span></div>
      </div>

      <div className="map-wrap">
        <div id="map" ref={mapElRef} />
        {loading && <div className="map-loading">Načítám nabídky…</div>}
      </div>

      <div className="bottombar">
        {nearbyVenue && (
          <a className="alert-card" href={affiliateUrl(nearbyVenue)} target="_blank" rel="noopener">
            <div className="badge">{nearbyVenue.discount_pct ?? calcPct(nearbyVenue.price, nearbyVenue.original_price) ?? "?"}%</div>
            <div className="body">
              <p className="title">{nearbyVenue.name}</p>
              <p className="desc">{nearbyVenue.offer} · {formatDistance(nearbyVenue.distance)}</p>
            </div>
            <div style={{ fontSize: 16, color: "var(--green)", flexShrink: 0 }}>→</div>
          </a>
        )}
        <div className="actions-row">
          <button className={`btn filter ${activeCats ? "active" : ""}`} onClick={openFilter}>
            ⊞ {filterLabel}
          </button>
        </div>
      </div>

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
              <button className="btn-all" onClick={() => setPendingCats(null)}>Vybrat vše</button>
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

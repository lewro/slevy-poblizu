"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import { distanceMeters } from "../../lib/geo";
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

function buildGroupPopupHtml(group) {
  if (group.length === 1) return buildPopupHtml(group[0]);

  const address = group[0].address || "";
  const items = group.map(v => {
    const pct = v.discount_pct ?? calcPct(v.price, v.original_price);
    const priceHtml = v.price
      ? `<span style="font-size:14px;color:#000">${v.price} Kč</span>
         ${v.original_price ? `&nbsp;<s style="font-size:12px;color:#bbb">${v.original_price} Kč</s>` : ""}
         ${pct ? `&nbsp;<span style="font-size:12px;color:#22c55e">-${pct}%</span>` : ""}`
      : "";
    return `<div style="padding:14px 0;border-bottom:1px solid #f0f0f0">
      <div style="font-size:13px;color:#000;line-height:1.35;margin-bottom:4px">${v.name}</div>
      ${v.offer ? `<div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.4">${v.offer}</div>` : ""}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div>${priceHtml}</div>
        <a href="${affiliateUrl(v)}" target="_blank" rel="noopener"
          style="flex-shrink:0;padding:7px 14px;background:#000;color:#fff;border-radius:100px;
                 font-size:11px;font-weight:400;text-decoration:none;white-space:nowrap">
          Koupit
        </a>
      </div>
    </div>`;
  }).join("");

  return `<div style="min-width:260px;max-width:300px">
    <div style="padding:20px 16px 0;padding-top:44px">
      <div style="font-size:12px;font-weight:400;color:#22c55e;margin-bottom:2px">${group.length} nabídky na stejném místě</div>
      ${address ? `<div style="font-size:12px;color:#888;margin-bottom:0">${address}</div>` : ""}
    </div>
    <div style="padding:0 16px 16px;max-height:55vh;overflow-y:auto">
      ${items}
    </div>
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
  const selectedRawRef    = useRef(RESTAURANT_RAW);
  const userPositionRef   = useRef(null);

  const [tracking,      setTracking]      = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [showFilter,    setShowFilter]    = useState(false);
  const [allCategories, setAllCategories] = useState([]);
  const [pendingCats,   setPendingCats]   = useState(new Set(["Restaurace a bary"]));
  const [activeCats,    setActiveCats]    = useState(["Restaurace a bary"]);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstall,   setShowInstall]   = useState(false);
  const [showIOS,       setShowIOS]       = useState(false);
  const [showSearch,    setShowSearch]    = useState(false);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching,     setSearching]     = useState(false); // normalized names

  // PWA install prompt
  useEffect(() => {
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches
      || navigator.standalone === true;
    if (isStandalone) return;
    setShowInstall(true); // always show the button when not installed

    const handler = e => {
      e.preventDefault();
      setInstallPrompt(e); // native prompt available
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) { setShowIOS(true); return; }

    if (installPrompt) {
      // Native Chrome prompt available — use it
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") setShowInstall(false);
      setInstallPrompt(null);
    } else {
      // No native prompt (cooldown after uninstall, or criteria not met)
      // Show manual instructions
      setShowIOS(true); // reuse the overlay, content updated below
    }
  };

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

    if (selectedRawRef.current) query = query.in("category", selectedRawRef.current);

    const { data } = await query;
    setLoading(false);
    if (!data) return;

    // Merge all into venuesRef for proximity detection
    const existingIds = new Set(venuesRef.current.map(v => v.id));
    venuesRef.current = [...venuesRef.current, ...data.filter(v => !existingIds.has(v.id))];

    // Group offers by location (round to 4 decimals ≈ 11m precision)
    const groups = {};
    for (const v of data) {
      const key = `${v.lat.toFixed(4)},${v.lng.toFixed(4)}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    }

    for (const [locKey, group] of Object.entries(groups)) {
      if (markersRef.current[locKey]) continue; // already rendered

      const { lat, lng } = group[0];
      const count = group.length;

      // Best discount in group
      const bestPct = group.reduce((best, v) => {
        const p = v.discount_pct ?? calcPct(v.price, v.original_price);
        return p != null && p > best ? p : best;
      }, 0);

      const labelHtml = count > 1
        ? `<span class="pin-pct">${count}×</span><span class="pin-name">${group[0].name?.slice(0, 18) ?? ""}</span>`
        : `${bestPct ? `<span class="pin-pct">-${bestPct}%</span>` : ""}<span class="pin-name">${group[0].name?.slice(0, 20) ?? ""}</span>`;

      const pinId = `pin-${locKey.replace(",", "_").replace(".", "_").replace(".", "_")}`;

      const icon = L.divIcon({
        className: "",
        html: `<div class="venue-pin" id="${pinId}">
          <div class="pin-label">${labelHtml}</div>
          <div class="pin-dot"></div>
        </div>`,
        iconSize: [160, 48],
        iconAnchor: [80, 48],
        popupAnchor: [0, -34],
      });

      const marker = L.marker([lat, lng], { icon }).addTo(map);
      marker.bindPopup(buildGroupPopupHtml(group), { maxWidth: 300, minWidth: 260 });

      marker.on("popupopen", () => {
        const label = document.querySelector(`#${pinId} .pin-label`);
        if (label) label.style.visibility = "hidden";
      });
      marker.on("popupclose", () => {
        const label = document.querySelector(`#${pinId} .pin-label`);
        if (label) label.style.visibility = "";
      });

      markersRef.current[locKey] = marker;
    }
  }, [today]);

  const reloadMarkers = useCallback(() => {
    const map = mapRef.current;
    const L   = lRef.current;
    if (!map || !L) return;
    Object.values(markersRef.current).forEach(m => map.removeLayer(m));
    markersRef.current = {};
    venuesRef.current  = [];
    refreshMarkers(map, L);
  }, [refreshMarkers]);

  // Init map
  useEffect(() => {
    let map;
    (async () => {
      const L = (await import("leaflet")).default;
      delete L.Icon.Default.prototype._getIconUrl;
      lRef.current = L;

      map = L.map(mapElRef.current, { zoomControl: false, attributionControl: false })
              .setView([50.0784, 14.4424], 13);
      mapRef.current = map;

      L.control.zoom({ position: "topright" }).addTo(map);

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
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
        userPositionRef.current = { lat: latitude, lng: longitude };
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
              radius: accuracy, color: "#ef4444", weight: 1, fillOpacity: 0.08,
            }).addTo(map);
          } else {
            userMarkerRef.current.setLatLng([latitude, longitude]);
            accuracyCircleRef.current.setLatLng([latitude, longitude]).setRadius(accuracy);
          }
        })();

        let closest = null;
        for (const v of venuesRef.current) {
          const d = distanceMeters(latitude, longitude, v.lat, v.lng);
          if (d <= ALERT_RADIUS_M && (!closest || d < closest.distance)) closest = { ...v, distance: d };
        }
      },
      () => setTracking(false),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [markPinInRange]);

  const searchTimer = useRef(null);

  const doSearch = async (q) => {
    if (!q.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=cz,sk&limit=6&addressdetails=1`;
      const res = await fetch(url, { headers: { "User-Agent": "ZaRohem/1.0" } });
      const data = await res.json();
      setSearchResults(data);
    } catch (e) { /* ignore */ }
    setSearching(false);
  };

  const onSearchInput = (e) => {
    const q = e.target.value;
    setSearchQuery(q);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(q), 350);
  };

  const selectResult = (result) => {
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);
    if (mapRef.current) mapRef.current.setView([lat, lng], 16, { animate: true });
    setShowSearch(false);
    setSearchQuery("");
    setSearchResults([]);
  };

  const closeSearch = () => {
    setShowSearch(false);
    setSearchQuery("");
    setSearchResults([]);
  };

  const centerOnUser = () => {
    const map = mapRef.current;
    const pos = userPositionRef.current;
    if (!map || !pos) return;
    map.setView([pos.lat, pos.lng], 19, { animate: true });
  };

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
        <button className="search-btn" onClick={() => setShowSearch(true)}>🔍</button>
        <img src="/icons/icon.svg" className="topbar-icon" alt="Za rohem" />
        {showInstall && (
          <button className="install-btn" onClick={handleInstall}>
            ⊕ Přidat aplikaci
          </button>
        )}
      </div>

      {showSearch && (
        <div className="search-overlay" onClick={closeSearch}>
          <div className="search-panel" onClick={e => e.stopPropagation()}>
            <div className="search-input-row">
              <span className="search-icon-inner">🔍</span>
              <input
                className="search-input"
                autoFocus
                placeholder="Hledat ulici nebo místo…"
                value={searchQuery}
                onChange={onSearchInput}
                onKeyDown={e => e.key === "Escape" && closeSearch()}
              />
              <button className="search-close" onClick={closeSearch}>✕</button>
            </div>
            {searching && <div className="search-status">Hledám…</div>}
            {!searching && searchResults.length > 0 && (
              <div className="search-results">
                {searchResults.map((r, i) => (
                  <div key={i} className="search-result-item" onClick={() => selectResult(r)}>
                    <span className="result-name">{r.display_name.split(",")[0]}</span>
                    <span className="result-sub">{r.display_name.split(",").slice(1, 3).join(",").trim()}</span>
                  </div>
                ))}
              </div>
            )}
            {!searching && searchQuery.length > 1 && searchResults.length === 0 && (
              <div className="search-status">Nic nenalezeno</div>
            )}
          </div>
        </div>
      )}

      <div className="map-wrap">
        <div id="map" ref={mapElRef} />
        {loading && <div className="map-loading">Načítám nabídky…</div>}
        <button className="center-btn" onClick={centerOnUser} title="Zpět na moji polohu">
          ◎
        </button>
      </div>

      <div className="bottombar">
      <div className="actions-row">
          <button className={`btn filter ${activeCats ? "active" : ""}`} onClick={openFilter}>
            ⊞ {filterLabel}
          </button>
        </div>
      </div>

      {showIOS && (
        <div className="ios-overlay" onClick={() => setShowIOS(false)}>
          <div className="ios-sheet" onClick={e => e.stopPropagation()}>
            {/iphone|ipad|ipod/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") ? (
              <>
                <h3>Přidat na plochu (iOS)</h3>
                <p>1. Klepněte na <strong>Sdílet</strong> (čtvereček se šipkou) v Safari.</p>
                <p>2. Vyberte <strong>Přidat na plochu</strong>.</p>
                <p>3. Potvrďte klepnutím na <strong>Přidat</strong>.</p>
              </>
            ) : (
              <>
                <h3>Přidat na plochu (Android)</h3>
                <p>Chrome dočasně blokuje automatickou instalaci. Přidejte appku ručně:</p>
                <p>1. Klepněte na menu <strong>⋮</strong> vpravo nahoře v Chromu.</p>
                <p>2. Vyberte <strong>Přidat na plochu</strong> nebo <strong>Nainstalovat aplikaci</strong>.</p>
                <p>3. Potvrďte.</p>
              </>
            )}
            <button className="ios-close" onClick={() => setShowIOS(false)}>Rozumím</button>
          </div>
        </div>
      )}

      {showFilter && (        <div className="filter-overlay" onClick={() => setShowFilter(false)}>
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

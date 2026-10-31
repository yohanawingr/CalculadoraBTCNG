// Precios de GPU en fracciones BTC; todos escalan con la cotización del juego.
const gpuPrices = {
    roja: 1 / 19,
    azul: 2 / 19,
    amarilla: 4 / 19,
    gris: 6 / 19,
    verde: 10 / 19
};

// Definición de Paquetes: cantidades y datos originales conservados.
const packages = {
    basico: {
        name: "Paquete Básico",
        desc: "10x GT 710 Rojas + 10x GTX 1050 Ti Azules",
        qtys: { roja: 10, azul: 10, amarilla: 0, gris: 0, verde: 0 }
    },
    intermedio: {
        name: "Paquete Intermedio",
        desc: "10x GTX 1050 Ti Azules + 10x GTX 1660 Amarillas",
        qtys: { roja: 0, azul: 10, amarilla: 10, gris: 0, verde: 0 }
    },
    avanzado: {
        name: "Paquete Avanzado",
        desc: "10x GTX 1660 + 5x RTX 2060 + 5x RTX 3090",
        qtys: { roja: 0, azul: 0, amarilla: 10, gris: 5, verde: 5 }
    }
};

const MINER_BTC_PER_CYCLE = 7.60962581;
const BTC_PER_SALON_CYCLE = MINER_BTC_PER_CYCLE;
const CYCLE_HOURS = 84;
const BTC_API_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
const STORAGE = {
    price: "btc-dashboard-last-price",
    priceTimestamp: "btc-dashboard-last-price-timestamp",
    priceHistory: "btc-dashboard-price-history",
    calculations: "btc-dashboard-calculations",
    sound: "btc-dashboard-miner-sound",
    minerTimer: "btc-dashboard-miner-timer"
};
const GPU_KEYS = ["roja", "azul", "amarilla", "gris", "verde"];

let currentPackage = null;
let currentPackageKey = null;
let marketPrice = 80450;
let manualPrice = null;
let marketChange24h = null;
let lastUpdatedAt = null;
let lastFetchAttemptAt = 0;
let isManualPrice = false;
let modalReturnFocus = null;
let activeTab = "calculadora";
let tickerTimer = null;
let minerTimerInterval = null;
let minerTimerState = null;
let priceRequestInFlight = false;
let priceRetryDelay = 60000;

const $ = (id) => document.getElementById(id);

function readStorage(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
    } catch (error) {
        console.error(`No se pudo leer el almacenamiento local (${key}).`, error);
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.error(`No se pudo guardar en el almacenamiento local (${key}).`, error);
        showToast("No se pudo guardar este dato en el dispositivo.", true);
        return false;
    }
}

function formatUSD(value, maximumFractionDigits = 0) {
    const formatted = new Intl.NumberFormat("de-DE", {
        maximumFractionDigits
    }).format(Number.isFinite(value) ? value : 0);
    return `$${formatted}`;
}

function formatBTC(value, digits = 8) {
    return `${(Number.isFinite(value) ? value : 0).toFixed(digits)} BTC`;
}

function animateValue(element) {
    if (!element || typeof element.animate !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
        [{ transform: "translateY(3px)", opacity: 0.45 }, { transform: "translateY(0)", opacity: 1 }],
        { duration: 260, easing: "ease-out" }
    );
}

function flashValue(element, direction) {
    if (!element) return;
    element.classList.remove("update-flash", "flash-positive", "flash-negative");
    element.classList.add(direction < 0 ? "flash-negative" : "flash-positive");
    void element.offsetWidth;
    element.classList.add("update-flash");
    window.setTimeout(() => element.classList.remove("update-flash", "flash-positive", "flash-negative"), 600);
}

// Pestañas con estado ARIA sincronizado.
function switchTab(tab) {
    if (!["calculadora", "generador"].includes(tab) || tab === activeTab) return;
    applyTab(tab);
}

function applyTab(tab) {
    activeTab = tab;
    const isCalculator = tab === "calculadora";
    $("tab-btn-calculadora").classList.toggle("is-active", isCalculator);
    $("tab-btn-generador").classList.toggle("is-active", !isCalculator);
    $("tab-btn-calculadora").setAttribute("aria-selected", String(isCalculator));
    $("tab-btn-generador").setAttribute("aria-selected", String(!isCalculator));
    $("tab-content-calculadora").classList.toggle("hidden", !isCalculator);
    $("tab-content-generador").classList.toggle("hidden", isCalculator);
}

// Modal accesible del selector de paquetes.
function openPackageModal() {
    modalReturnFocus = document.activeElement;
    $("package-modal").classList.remove("hidden");
    $("package-modal").querySelector(".modal-dialog").focus();
    document.body.classList.add("modal-open");
}

function closePackageModal() {
    if ($("package-modal").classList.contains("hidden")) return;
    $("package-modal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    if (modalReturnFocus && typeof modalReturnFocus.focus === "function") modalReturnFocus.focus();
}

function selectPackage(pkgKey, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(packages, pkgKey)) {
        showToast("No se pudo seleccionar ese paquete.", true);
        return;
    }
    currentPackageKey = pkgKey;
    currentPackage = packages[pkgKey];

    $("selected-package-name").textContent = currentPackage.name;
    $("selected-package-desc").textContent = currentPackage.desc;
    $("empty-gpu-state").classList.add("hidden");
    document.querySelectorAll(".package-option").forEach((option) => {
        const selected = option.dataset.package === pkgKey;
        option.classList.toggle("is-selected", selected);
        option.setAttribute("aria-pressed", String(selected));
    });

    GPU_KEYS.forEach((gpu) => {
        const qty = currentPackage.qtys[gpu];
        $(`input-qty-${gpu}`).value = qty;
        $(`cpu-card-${gpu}`).classList.toggle("hidden", qty === 0);
    });

    $("salon-generation-card").classList.remove("hidden");
    closePackageModal();
    calculateTotals({ saveHistory: options.saveHistory !== false });
}

// Cálculo original de inversión y generación por salón.
function calculateTotals(options = {}) {
    if (!currentPackage) return;

    const salonesInput = $("salones-input");
    const hasSalonValue = salonesInput.value.trim() !== "";
    const rawSalones = Number.parseInt(salonesInput.value, 10);
    const salonesCount = Math.min(100, Math.max(1, Number.isFinite(rawSalones) ? rawSalones : 1));
    if (hasSalonValue) salonesInput.value = salonesCount;
    let totalGeneralUSD = 0;

    GPU_KEYS.forEach((gpu) => {
        const totalQty = currentPackage.qtys[gpu] * salonesCount;
        const unitPrice = gpuPrices[gpu] * effectivePrice();
        const subtotal = totalQty * unitPrice;
        totalGeneralUSD += subtotal;

        $(`input-qty-${gpu}`).value = totalQty;
        $(`subtotal-${gpu}`).textContent = `${formatUSD(subtotal)} USD`;
        $(`unit-${gpu}`).textContent = `Unit: ${formatUSD(unitPrice)}`;
    });

    const totalElement = $("total-general");
    const previousTotal = Number.parseFloat(totalElement.dataset.value || "0");
    totalElement.dataset.value = String(totalGeneralUSD);
    totalElement.textContent = `${formatUSD(totalGeneralUSD)} USD`;
    animateValue(totalElement);
    if (previousTotal && previousTotal !== totalGeneralUSD) flashValue(totalElement, Math.sign(totalGeneralUSD - previousTotal));

    $("grand-total-subtitle").textContent = `Calculado para ${salonesCount} tienda(s) en base al ${currentPackage.name}`;
    const btcGeneration = BTC_PER_SALON_CYCLE * salonesCount;
    $("btc-generation-output").textContent = formatBTC(btcGeneration);
    $("total-btc-equivalent").textContent = marketPrice > 0 ? formatBTC(totalGeneralUSD / effectivePrice()) : "— BTC";
    renderComparisons();
    updateMinerSimulation();

    if (options.saveHistory) saveCalculation(totalGeneralUSD, salonesCount);
}

// Ticker BTC, sparkline y recuperación del último precio guardado ante fallos.
function readPriceHistory() {
    try {
        const history = JSON.parse(readStorage(STORAGE.priceHistory, "[]"));
        return Array.isArray(history) ? history.filter(Number.isFinite).slice(-24) : [];
    } catch (error) {
        console.error("El historial local de precios BTC no tiene un formato válido.", error);
        return [];
    }
}

let priceHistory = readPriceHistory();

function renderSparkline() {
    const svg = $("btc-sparkline");
    const points = priceHistory.slice(-24);
    svg.querySelector("polyline").setAttribute("points", buildSparklinePoints(points));
    svg.classList.toggle("is-negative", points.length > 1 && points[points.length - 1] < points[0]);
}

function buildSparklinePoints(values) {
    if (values.length < 2) return "0,25 18,21 36,23 54,14 72,18 90,10 108,12";
    const min = Math.min(...values);
    const range = Math.max(...values) - min || 1;
    return values.map((value, index) => {
        const x = (index / (values.length - 1)) * 108;
        const y = 29 - ((value - min) / range) * 23;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
}

function renderUpdatedTime() {
    if (!lastUpdatedAt) {
        $("btc-updated").textContent = "Esperando precio";
        return;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000));
    $("btc-updated").textContent = `Actualizado hace ${seconds}s`;
}

function renderMarketPrice(previousPrice = marketPrice) {
    const priceElement = $("header-btc-price");
    priceElement.classList.remove("skeleton");
    priceElement.textContent = `${formatUSD(marketPrice)} USD`;
    $("btc-change").textContent = Number.isFinite(marketChange24h)
        ? `${marketChange24h >= 0 ? "+" : ""}${marketChange24h.toFixed(2)}%`
        : "—";
    $("btc-change").classList.toggle("is-negative", Number.isFinite(marketChange24h) && marketChange24h < 0);
    const direction = marketPrice - previousPrice;
    const trendDirection = Number.isFinite(marketChange24h) ? marketChange24h : direction;
    $("btc-trend-icon").textContent = trendDirection < 0 ? "▼" : trendDirection > 0 ? "▲" : "•";
    $("btc-trend-icon").classList.toggle("is-negative", trendDirection < 0);
    $("btc-trend-icon").setAttribute("aria-label", trendDirection < 0 ? "Precio a la baja" : trendDirection > 0 ? "Precio al alza" : "Precio sin cambio");
    if (direction !== 0) flashValue(priceElement, direction);
    renderUpdatedTime();

    if (!isManualPrice) $("btc-price-input").value = String(Math.round(marketPrice));
    $("btc-price-input").readOnly = !isManualPrice;
    updatePriceDerivedValues();
    if (currentPackage) calculateTotals();
    else updateMinerSimulation();
}

function showPriceError(message) {
    $("price-error-text").textContent = message;
    $("price-error-banner").classList.remove("hidden");
    $("sync-status").classList.add("is-loading");
    $("sync-status").innerHTML = '<i class="live-dot"></i> CARGANDO';
}

function hidePriceError() {
    $("price-error-banner").classList.add("hidden");
    $("sync-status").classList.remove("is-loading");
    $("sync-status").innerHTML = '<i class="live-dot"></i> EN VIVO';
}

async function fetchBitcoinPrice() {
    if (priceRequestInFlight) return;
    priceRequestInFlight = true;
    const refreshButton = $("refresh-btc");
    refreshButton.classList.add("is-loading");
    lastFetchAttemptAt = Date.now();
    $("sync-status").classList.add("is-loading");
    $("sync-status").innerHTML = '<i class="live-dot"></i> CARGANDO';
    try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 10000);
        let response;
        try {
            response = await fetch(BTC_API_URL, { cache: "no-store", signal: controller.signal });
        } finally {
            window.clearTimeout(timeout);
        }
        if (!response.ok) throw new Error(`La API respondió con estado ${response.status}.`);
        const result = await response.json();
        const newPrice = Number(result?.bitcoin?.usd);
        const change = Number(result?.bitcoin?.usd_24h_change);
        if (!Number.isFinite(newPrice) || newPrice <= 0) throw new Error("La API no devolvió un precio BTC válido.");

        const previous = marketPrice;
        marketPrice = newPrice;
        marketChange24h = Number.isFinite(change) ? change : null;
        lastUpdatedAt = Date.now();
        priceHistory.push(newPrice);
        priceHistory = priceHistory.slice(-24);
        writeStorage(STORAGE.price, String(newPrice));
        writeStorage(STORAGE.priceTimestamp, String(lastUpdatedAt));
        writeStorage(STORAGE.priceHistory, JSON.stringify(priceHistory));
        renderSparkline();
        renderMarketPrice(previous);
        priceRetryDelay = 60000;
        hidePriceError();
    } catch (error) {
        console.error("No se pudo actualizar el precio de Bitcoin.", error);
        priceRetryDelay = 15000;
        const cachedPrice = Number(readStorage(STORAGE.price, ""));
        if (Number.isFinite(cachedPrice) && cachedPrice > 0) {
            const previous = marketPrice;
            marketPrice = cachedPrice;
            const cachedTimestamp = Number(readStorage(STORAGE.priceTimestamp, ""));
            lastUpdatedAt = Number.isFinite(cachedTimestamp) && cachedTimestamp > 0 ? cachedTimestamp : null;
            renderMarketPrice(previous);
            showPriceError("No pudimos actualizar el precio por ahora. Seguimos usando la última cotización guardada; espera un momento y volveremos a intentarlo automáticamente.");
        } else {
            renderMarketPrice(marketPrice);
            showPriceError("Estamos conectando con el servicio de precios. Mientras tanto, usamos el precio de referencia y volveremos a intentarlo automáticamente en unos segundos.");
        }
    } finally {
        refreshButton.classList.remove("is-loading");
        priceRequestInFlight = false;
    }
}

// Las proyecciones usan el precio de referencia actual.
function effectivePrice() {
    return getReferencePrice();
}

function getReferencePrice() {
    return isManualPrice && Number.isFinite(manualPrice) ? manualPrice : marketPrice;
}

function updatePriceDerivedValues() {
    const referencePrice = effectivePrice();
    $("miner-effective-price").textContent = `${formatUSD(referencePrice)} USD`;
    $("total-btc-equivalent").textContent = currentPackage
        ? formatBTC((Number.parseFloat($("total-general").dataset.value) || 0) / (referencePrice || 1))
        : "— BTC";
    if (currentPackage) calculateTotals();
    else {
        renderComparisons();
        updateMinerSimulation();
    }
}

// La inversión de cada paquete se calcula en BTC y se convierte al precio de referencia.
function packageInvestmentBTC(pkg) {
    return GPU_KEYS.reduce((sum, gpu) => sum + pkg.qtys[gpu] * gpuPrices[gpu], 0);
}

function renderComparisons() {
    const btcPrice = effectivePrice();
    const hourlyBTC = MINER_BTC_PER_CYCLE / CYCLE_HOURS;
    const investments = Object.entries(packages).map(([key, pkg]) => ({
        key,
        pkg,
        investmentBTC: packageInvestmentBTC(pkg),
        investment: packageInvestmentBTC(pkg) * btcPrice
    }));
    const best = investments.reduce((candidate, item) => item.investment < candidate.investment ? item : candidate, investments[0]);
    $("package-comparison").innerHTML = investments.map(({ key, pkg, investmentBTC, investment }) => {
        const roiHours = hourlyBTC > 0 ? investmentBTC / hourlyBTC : Infinity;
        const roi = Number.isFinite(roiHours) ? `${Math.floor(roiHours / 24)}d ${Math.floor(roiHours % 24)}h` : "—";
        return `<article class="comparison-card ${key === best.key ? "is-best" : ""}">
            ${key === best.key ? '<span class="best-badge">MEJOR RENDIMIENTO</span>' : ""}
            <h3>${pkg.name.replace("Paquete ", "")}</h3>
            <div class="comparison-metrics">
                <div class="comparison-metric"><span>Inversión / salón</span><strong>${formatUSD(investment)}</strong></div>
                <div class="comparison-metric"><span>Generación / hora</span><strong>${hourlyBTC.toFixed(8)} BTC</strong></div>
                <div class="comparison-metric"><span>Retorno estimado</span><strong>${roi}</strong></div>
            </div>
        </article>`;
    }).join("");
}

// Conversor USD ⇄ BTC ⇄ satoshis.
function updateConverter(source) {
    const price = effectivePrice();
    const usdInput = $("converter-usd");
    const btcInput = $("converter-btc");
    let usd = Number(source === "btc" ? btcInput.value : usdInput.value);
    if (!Number.isFinite(usd) || usd < 0) usd = 0;
    const btc = price > 0 ? (source === "btc" ? usd : usd / price) : 0;
    if (source === "btc") usdInput.value = (btc * price).toFixed(2);
    else btcInput.value = btc.toFixed(8);
    $("converter-sats").textContent = `${Math.round(btc * 100000000).toLocaleString("en-US")} sats`;
}

// Historial local limitado a diez cálculos y con repetición/borrado individual.
function getCalculationHistory() {
    try {
        const history = JSON.parse(readStorage(STORAGE.calculations, "[]"));
        return Array.isArray(history) ? history.filter((item) =>
            item && Object.prototype.hasOwnProperty.call(packages, item.packageKey) &&
            Number.isFinite(item.salones) && Number.isFinite(item.total)
        ).slice(0, 10) : [];
    } catch (error) {
        console.error("El historial de cálculos local no tiene un formato válido.", error);
        return [];
    }
}

function saveCalculation(total, salones) {
    const history = getCalculationHistory();
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        packageKey: currentPackageKey,
        salones,
        total,
        createdAt: new Date().toISOString()
    };
    history.unshift(entry);
    writeStorage(STORAGE.calculations, JSON.stringify(history.slice(0, 10)));
    renderHistory();
}

function renderHistory() {
    const history = getCalculationHistory();
    if (!history.length) {
        $("calculation-history").innerHTML = '<p class="history-empty">Tus cálculos recientes aparecerán aquí.</p>';
        return;
    }
    $("calculation-history").innerHTML = history.map((item) => {
        const date = new Date(item.createdAt);
        const dateText = Number.isNaN(date.getTime()) ? "Fecha no disponible" : date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
        return `<article class="history-item">
            <div class="history-details"><strong>${packages[item.packageKey].name} · ${item.salones} tienda(s)</strong><span>${formatUSD(item.total)} · ${dateText}</span></div>
            <div class="history-actions"><button type="button" data-repeat="${item.id}">Repetir</button><button type="button" data-delete="${item.id}" aria-label="Borrar cálculo">Borrar</button></div>
        </article>`;
    }).join("");
}

// Resumen preparado para Discord y acciones de compartir/exportar.
function createSummary() {
    if (!currentPackage) return null;
    const salons = Number.parseInt($("salones-input").value, 10) || 1;
    const investment = Number.parseFloat($("total-general").dataset.value) || 0;
    const generated = BTC_PER_SALON_CYCLE * salons;
    return [
        "**Resumen · Calculadora Salones BTC**",
        `> Paquete: **${currentPackage.name}**`,
        `> Salones / tiendas: **${salons}**`,
        `> Inversión total: **${formatUSD(investment)} USD**`,
        `> Generación estimada (84 h): **${formatBTC(generated)}**`,
        `> BTC de referencia: **${formatUSD(getReferencePrice())} USD${isManualPrice ? " (manual)" : ""}**`
    ].join("\n");
}

async function copySummary() {
    const summary = createSummary();
    if (!summary) {
        showToast("Selecciona un paquete antes de copiar el resumen.", true);
        return;
    }
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(summary);
        } else {
            const temporary = document.createElement("textarea");
            temporary.value = summary;
            temporary.setAttribute("readonly", "");
            temporary.style.position = "fixed";
            temporary.style.opacity = "0";
            document.body.appendChild(temporary);
            temporary.select();
            const copied = document.execCommand("copy");
            temporary.remove();
            if (!copied) throw new Error("El navegador no permitió copiar al portapapeles.");
        }
        showToast("Copiado ✓");
    } catch (error) {
        console.error("No se pudo copiar el resumen.", error);
        showToast("No se pudo copiar. Revisa los permisos del navegador.", true);
    }
}

async function shareSummary() {
    const summary = createSummary();
    if (!summary) {
        showToast("Selecciona un paquete antes de compartir.", true);
        return;
    }
    if (navigator.share) {
        try {
            await navigator.share({ title: "Resumen Salones BTC", text: summary });
        } catch (error) {
            if (error.name !== "AbortError") {
                console.error("No se pudo compartir el resumen.", error);
                showToast("No se pudo abrir el menú para compartir.", true);
            }
        }
        return;
    }
    await copySummary();
    showToast("Resumen copiado para compartir.");
}

function exportSummary() {
    const summary = createSummary();
    if (!summary) {
        showToast("Selecciona un paquete antes de exportar.", true);
        return;
    }
    const blob = new Blob([summary.replaceAll("**", "").replaceAll("> ", "")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "resumen-salones-btc.txt";
    link.click();
    URL.revokeObjectURL(url);
    showToast("Resumen exportado ✓");
}

// Simulador minero: mantiene la fórmula y estima su valor con el precio efectivo.
function updateMinerSimulation() {
    const input = $("miner-hours-input");
    const parsedHours = Number.parseInt(input.value, 10);
    const hours = Math.min(10000, Math.max(1, Number.isFinite(parsedHours) ? parsedHours : CYCLE_HOURS));
    input.value = hours;
    if (minerTimerState) {
        if (minerTimerState.status === "completed" && minerTimerState.durationHours !== hours) {
            minerTimerState.status = "paused";
        }
        minerTimerState.durationHours = hours;
        persistMinerTimer();
    }
    const calculatedBtc = (MINER_BTC_PER_CYCLE / CYCLE_HOURS) * hours;
    const usdVal = calculatedBtc * effectivePrice();
    $("miner-total-btc").textContent = formatBTC(calculatedBtc);
    $("miner-btc-usd-val").textContent = `Valor aprox: ${formatUSD(Math.round(usdVal))} USD`;
    $("miner-effective-price").textContent = `${formatUSD(effectivePrice())} USD`;
    updateProductionTable();
    updateMinerClock();
}

function updateProductionTable() {
    const btcPerHour = MINER_BTC_PER_CYCLE / CYCLE_HOURS;
    const price = effectivePrice();
    [
        { key: "hour", hours: 1 },
        { key: "day", hours: 24 },
        { key: "week", hours: 168 }
    ].forEach(({ key, hours }) => {
        const btc = btcPerHour * hours;
        $(`production-${key}-btc`).textContent = formatBTC(btc);
        $(`production-${key}-usd`).textContent = formatUSD(btc * price);
    });
}

function updateMinerClock() {
    if (!minerTimerState) return;
    const durationHours = Math.max(1, Number.parseInt($("miner-hours-input").value, 10) || CYCLE_HOURS);
    const durationMs = durationHours * 60 * 60 * 1000;
    let elapsedMs = getMinerElapsedMs();

    if (minerTimerState.status === "running" && elapsedMs >= durationMs) {
        elapsedMs = durationMs;
        minerTimerState.elapsedMs = durationMs;
        minerTimerState.startedAt = null;
        minerTimerState.status = "completed";
        persistMinerTimer();
        completeMinerCycle();
    }

    const progress = durationMs ? (elapsedMs / durationMs) * 100 : 0;
    const ringProgress = Math.min(progress, 100);
    const remainingMs = Math.max(0, durationMs - elapsedMs);
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    const remainingHours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    $("miner-progress-text").textContent = `${ringProgress.toFixed(1)}%`;
    $("miner-progress-ring").style.setProperty("--progress", `${ringProgress}%`);
    $("miner-progress-ring").setAttribute("aria-valuenow", String(ringProgress));
    $("miner-progress-bar").style.setProperty("--progress-scale", String(ringProgress / 100));
    $("miner-time-remaining").textContent = minerTimerState.status === "completed"
        ? "Ciclo completado"
        : `Restante: ${remainingHours}h ${minutes}m`;
    const running = minerTimerState.status === "running";
    const statusElement = $("miner-status-badge").parentElement;
    statusElement.classList.toggle("is-stopped", minerTimerState.status === "stopped");
    statusElement.classList.toggle("is-paused", minerTimerState.status === "paused");
    statusElement.classList.toggle("is-completed", minerTimerState.status === "completed");
    $("miner-status-badge").textContent = running
        ? "MINANDO"
        : minerTimerState.status === "completed" ? "CICLO COMPLETADO"
            : minerTimerState.status === "paused" ? "EN PAUSA" : "DETENIDO";
    $("miner-start-button").textContent = running
        ? "Ⅱ Pausar minería"
        : minerTimerState.status === "completed" ? "↻ Iniciar nuevo ciclo"
            : minerTimerState.elapsedMs > 0 ? "▶ Reanudar minería" : "▶ Iniciar minería";
    $("miner-start-button").setAttribute("aria-pressed", String(running));
}

function readMinerTimer() {
    try {
        const saved = JSON.parse(readStorage(STORAGE.minerTimer, "null"));
        if (!saved || !["stopped", "running", "paused", "completed"].includes(saved.status)) {
            return { durationHours: CYCLE_HOURS, elapsedMs: 0, startedAt: null, status: "stopped" };
        }
        const startedAt = Number.isFinite(Number(saved.startedAt)) && Number(saved.startedAt) > 0
            ? Number(saved.startedAt)
            : null;
        return {
            durationHours: Math.min(10000, Math.max(1, Number(saved.durationHours) || CYCLE_HOURS)),
            elapsedMs: Math.max(0, Number(saved.elapsedMs) || 0),
            startedAt,
            status: saved.status === "running" && !startedAt ? "paused" : saved.status
        };
    } catch (error) {
        console.error("No se pudo restaurar el reloj de minería.", error);
        return { durationHours: CYCLE_HOURS, elapsedMs: 0, startedAt: null, status: "stopped" };
    }
}

function getMinerElapsedMs(now = Date.now()) {
    if (!minerTimerState) return 0;
    const savedElapsed = Math.max(0, Number(minerTimerState.elapsedMs) || 0);
    if (minerTimerState.status !== "running" || !minerTimerState.startedAt) return savedElapsed;
    return savedElapsed + Math.max(0, now - minerTimerState.startedAt);
}

function persistMinerTimer() {
    if (!minerTimerState) return;
    if (minerTimerState.status === "running") {
        const now = Date.now();
        minerTimerState.elapsedMs = getMinerElapsedMs(now);
        minerTimerState.startedAt = now;
    }
    writeStorage(STORAGE.minerTimer, JSON.stringify(minerTimerState));
}

function completeMinerCycle() {
    $("miner-progress-ring").classList.add("is-complete");
    window.setTimeout(() => $("miner-progress-ring").classList.remove("is-complete"), 600);
    showToast("Ciclo de minería completado ✓");
    playCompletionSound();
}

function toggleMinerTimer() {
    if (!minerTimerState) minerTimerState = readMinerTimer();
    const now = Date.now();
    if (minerTimerState.status === "running") {
        minerTimerState.elapsedMs = getMinerElapsedMs(now);
        minerTimerState.startedAt = null;
        minerTimerState.status = "paused";
        persistMinerTimer();
        showToast("Minería pausada. El progreso quedó guardado.");
    } else {
        const durationHours = Math.max(1, Number.parseInt($("miner-hours-input").value, 10) || CYCLE_HOURS);
        if (minerTimerState.status === "completed" || minerTimerState.elapsedMs >= durationHours * 60 * 60 * 1000) {
            minerTimerState.elapsedMs = 0;
        }
        minerTimerState.durationHours = durationHours;
        minerTimerState.startedAt = now;
        minerTimerState.status = "running";
        persistMinerTimer();
        showToast("Minería iniciada. El reloj seguirá avanzando aunque cierres la página.");
    }
    updateMinerSimulation();
}

function resetMinerTimer() {
    if (!minerTimerState) minerTimerState = readMinerTimer();
    const now = Date.now();
    const durationHours = Math.max(1, Number.parseInt($("miner-hours-input").value, 10) || CYCLE_HOURS);
    minerTimerState = {
        durationHours,
        elapsedMs: 0,
        startedAt: now,
        status: "running"
    };
    persistMinerTimer();
    updateMinerSimulation();
    showToast("Reloj reiniciado. Nuevo ciclo de minería iniciado.");
}

let audioContext = null;

function playCompletionSound() {
    if (!$("sound-toggle").checked) return;
    try {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) throw new Error("Este navegador no admite Web Audio.");
        audioContext = audioContext || new AudioContextConstructor();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime + 0.12);
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.32);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.33);
    } catch (error) {
        console.error("No se pudo reproducir el sonido de finalización.", error);
        showToast("El sonido no está disponible en este navegador.", true);
    }
}

// Toasts sin diálogos intrusivos.
function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " is-error" : ""}`;
    toast.setAttribute("role", isError ? "alert" : "status");
    toast.textContent = message;
    $("toast-region").appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
}

// Preloader: track real resources and interpolate progress with a safety timeout.
function startPreloader() {
    const screen = $("intro-screen");
    if (!screen) return;
    if (!document.documentElement.classList.contains("preloader-active")) {
        screen.remove();
        document.documentElement.classList.add("page-ready");
        document.dispatchEvent(new CustomEvent("preloader:done"));
        return;
    }

    const MIN_VISIBLE_MS = 2200;
    const MAX_VISIBLE_MS = 7300;
    const startedAt = performance.now();
    const skipButton = $("preloader-skip");
    const progressBar = $("preloader-progress");
    const progressFill = $("preloader-progress-fill");
    const percentLabel = $("preloader-percent");
    const message = $("preloader-message");
    const chainBlocks = [...document.querySelectorAll(".chain-loader i")];
    const images = [...document.images];
    const originalFocus = document.activeElement;
    const originalBodyStyles = {
        position: document.body.style.position,
        top: document.body.style.top,
        width: document.body.style.width,
        overflow: document.body.style.overflow
    };
    const scrollY = window.scrollY;
    let completedImages = 0;
    let fontsReady = false;
    let windowLoaded = document.readyState === "complete";
    let displayedProgress = 0;
    let frameId = 0;
    let finished = false;

    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    screen.focus({ preventScroll: true });

    function updateProgress(value) {
        const progress = Math.max(0, Math.min(100, Math.round(value)));
        percentLabel.textContent = `${String(progress).padStart(2, "0")}%`;
        progressBar.setAttribute("aria-valuenow", String(progress));
        progressFill.style.transform = `scaleX(${progress / 100})`;
        chainBlocks.forEach((block, index) => block.classList.toggle("is-lit", progress >= (index + 1) * 18));
        const nextMessage = progress < 28 ? "Encendiendo motores..."
            : progress < 58 ? "Cargando recursos..."
            : progress < 86 ? "Conectando bloques..."
            : progress < 100 ? "Casi listo..." : "¡Bienvenido!";
        if (message.textContent !== nextMessage) message.textContent = nextMessage;
    }

    const skipTimer = window.setTimeout(() => { skipButton.hidden = false; }, 4000);
    function finishPreloader({ complete = true } = {}) {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(frameId);
        clearTimeout(window.__preloaderFallback);
        clearTimeout(skipTimer);
        if (complete) updateProgress(100);
        screen.classList.add("is-exiting");
        window.setTimeout(() => {
            screen.remove();
            document.documentElement.classList.remove("preloader-active");
            document.documentElement.classList.add("page-ready");
            document.body.style.position = originalBodyStyles.position;
            document.body.style.top = originalBodyStyles.top;
            document.body.style.width = originalBodyStyles.width;
            document.body.style.overflow = originalBodyStyles.overflow;
            window.scrollTo(0, scrollY);
            if (originalFocus && originalFocus !== document.body && originalFocus.isConnected && typeof originalFocus.focus === "function") {
                originalFocus.focus({ preventScroll: true });
            }
            document.dispatchEvent(new CustomEvent("preloader:done"));
        }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 460);
    }
    skipButton.addEventListener("click", finishPreloader, { once: true });

    const totalTasks = images.length + 2;
    const allResourcesReady = () => completedImages === images.length && fontsReady && windowLoaded;
    const onImageDone = () => { completedImages += 1; };
    images.forEach((image) => {
        if (image.complete) onImageDone();
        else {
            image.addEventListener("load", onImageDone, { once: true });
            image.addEventListener("error", onImageDone, { once: true });
        }
    });
    if (document.fonts?.ready) {
        document.fonts.ready.then(() => { fontsReady = true; }, () => { fontsReady = true; });
    } else fontsReady = true;
    window.addEventListener("load", () => { windowLoaded = true; }, { once: true });

    function animateProgress(now) {
        if (finished) return;
        const elapsed = now - startedAt;
        const resourceRatio = (completedImages + Number(fontsReady) + Number(windowLoaded)) / totalTasks;
        const gentleProgress = Math.min(92, (elapsed / MAX_VISIBLE_MS) * 92);
        const targetProgress = allResourcesReady() ? 100 : Math.min(94, Math.max(resourceRatio * 92, gentleProgress));
        displayedProgress += (targetProgress - displayedProgress) * Math.min(1, 0.12 + (now - (animateProgress.lastFrame || now)) / 140);
        animateProgress.lastFrame = now;
        updateProgress(displayedProgress);
        if (allResourcesReady() && elapsed >= MIN_VISIBLE_MS) {
            finishPreloader();
            return;
        }
        if (elapsed >= MAX_VISIBLE_MS) {
            finishPreloader({ complete: false });
            return;
        }
        frameId = requestAnimationFrame(animateProgress);
    }
    frameId = requestAnimationFrame(animateProgress);
}
startPreloader();

function handleModalKeyboard(event) {
    if (event.key === "Escape" && !$("package-modal").classList.contains("hidden")) {
        closePackageModal();
        return;
    }
    if (event.key !== "Tab" || $("package-modal").classList.contains("hidden")) return;
    const dialog = $("package-modal").querySelector(".modal-dialog");
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function handleGlobalShortcuts(event) {
    const target = event.target;
    const isTyping = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    if (event.key === "Escape") {
        handleModalKeyboard(event);
        return;
    }
    if (isTyping || event.altKey || event.ctrlKey || event.metaKey) return;
}

// Conectar componentes de interfaz.
document.querySelectorAll(".package-option").forEach((option) => {
    option.addEventListener("click", () => selectPackage(option.dataset.package));
});
document.querySelectorAll('[role="tab"]').forEach((button) => {
    button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const nextTab = activeTab === "calculadora" ? "generador" : "calculadora";
            switchTab(nextTab);
            $(`tab-btn-${nextTab}`).focus();
        }
    });
});
document.addEventListener("keydown", handleGlobalShortcuts);
document.addEventListener("keydown", handleModalKeyboard);
document.addEventListener("pointermove", (event) => {
    const panel = event.target.closest?.(".panel");
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    panel.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
    panel.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
}, { passive: true });
document.addEventListener("click", (event) => {
    if (event.target === $("package-modal")) closePackageModal();
});

$("salones-input").addEventListener("input", (event) => {
    const isTemporarilyEmpty = event.target.value.trim() === "";
    calculateTotals({ saveHistory: !isTemporarilyEmpty });
});
$("salones-input").addEventListener("blur", (event) => {
    if (event.target.value.trim() !== "") return;
    event.target.value = "1";
    calculateTotals({ saveHistory: true });
});
$("miner-start-button").addEventListener("click", toggleMinerTimer);
$("miner-hours-input").addEventListener("change", () => {
    if (!minerTimerState) return;
    minerTimerState.durationHours = Number.parseInt($("miner-hours-input").value, 10) || CYCLE_HOURS;
    persistMinerTimer();
    updateMinerClock();
});
$("refresh-btc").addEventListener("click", fetchBitcoinPrice);
$("dismiss-price-error").addEventListener("click", () => $("price-error-banner").classList.add("hidden"));
$("toggle-btc-mode").addEventListener("click", () => {
    isManualPrice = !isManualPrice;
    const input = $("btc-price-input");
    input.readOnly = !isManualPrice;
    $("toggle-btc-mode").textContent = isManualPrice ? "Usar automático" : "Usar Manual";
    $("btc-price-help").textContent = isManualPrice
        ? "Precio manual activo. El ticker de mercado sigue actualizado independientemente."
        : "Precio de mercado sincronizado automáticamente.";
    if (!isManualPrice) {
        manualPrice = null;
        input.removeAttribute("aria-invalid");
        input.parentElement.classList.remove("is-invalid");
        input.value = String(Math.round(marketPrice));
        input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
        manualPrice = Number(input.value) || marketPrice;
        input.focus();
    }
});
$("btc-price-input").addEventListener("input", (event) => {
    const inputPrice = Number(event.target.value);
    if (!Number.isFinite(inputPrice) || inputPrice <= 0) {
        event.target.setAttribute("aria-invalid", "true");
        event.target.parentElement.classList.add("is-invalid");
        $("btc-price-help").textContent = "Introduce un precio mayor que cero para actualizar la proyección.";
        return;
    }
    event.target.removeAttribute("aria-invalid");
    event.target.parentElement.classList.remove("is-invalid");
    $("btc-price-help").textContent = "Precio manual activo. El ticker de mercado sigue actualizado independientemente.";
    if (isManualPrice) manualPrice = inputPrice;
    updatePriceDerivedValues();
});
$("btc-price-input").addEventListener("blur", (event) => {
    if (!event.target.hasAttribute("aria-invalid")) return;
    event.target.value = String(Math.round(manualPrice || marketPrice));
    event.target.removeAttribute("aria-invalid");
    event.target.parentElement.classList.remove("is-invalid");
    $("btc-price-help").textContent = "Precio manual activo. El ticker de mercado sigue actualizado independientemente.";
});
$("converter-usd").addEventListener("input", () => updateConverter("usd"));
$("converter-btc").addEventListener("input", () => updateConverter("btc"));
$("share-summary-button").addEventListener("click", shareSummary);
$("export-summary-button").addEventListener("click", exportSummary);
$("clear-history").addEventListener("click", () => {
    if (!getCalculationHistory().length) {
        showToast("El historial ya está vacío.");
        return;
    }
    try {
        localStorage.removeItem(STORAGE.calculations);
    } catch (error) {
        console.error("No se pudo borrar el historial local.", error);
        showToast("No se pudo borrar el historial.", true);
        return;
    }
    renderHistory();
    showToast("Historial borrado.");
});
$("calculation-history").addEventListener("click", (event) => {
    const repeatButton = event.target.closest("[data-repeat]");
    const deleteButton = event.target.closest("[data-delete]");
    const history = getCalculationHistory();
    if (repeatButton) {
        const item = history.find((entry) => entry.id === repeatButton.dataset.repeat);
        if (item) {
            $("salones-input").value = item.salones;
            switchTab("calculadora");
            selectPackage(item.packageKey, { saveHistory: false });
            showToast("Cálculo restaurado.");
        }
    }
    if (deleteButton) {
        const nextHistory = history.filter((entry) => entry.id !== deleteButton.dataset.delete);
        writeStorage(STORAGE.calculations, JSON.stringify(nextHistory));
        renderHistory();
    }
});
$("sound-toggle").addEventListener("change", (event) => {
    writeStorage(STORAGE.sound, String(event.target.checked));
    if (event.target.checked) showToast("Aviso sonoro activado.");
});

// Inicialización.
document.documentElement.dataset.theme = "dark";

const savedPrice = Number(readStorage(STORAGE.price, ""));
if (Number.isFinite(savedPrice) && savedPrice > 0) marketPrice = savedPrice;
const cachedPriceTimestamp = Number(readStorage(STORAGE.priceTimestamp, ""));
lastUpdatedAt = Number.isFinite(cachedPriceTimestamp) && cachedPriceTimestamp > 0 ? cachedPriceTimestamp : null;
if (!isManualPrice) $("btc-price-input").value = String(Math.round(marketPrice));
priceHistory = readPriceHistory();
if (!priceHistory.length) priceHistory = [marketPrice];
renderSparkline();
if (Number.isFinite(savedPrice) && savedPrice > 0) renderMarketPrice(marketPrice);
else {
    $("header-btc-price").textContent = "Cargando...";
    renderUpdatedTime();
}
renderComparisons();
renderHistory();
$("sound-toggle").checked = readStorage(STORAGE.sound, "false") === "true";
minerTimerState = readMinerTimer();
$("miner-hours-input").value = String(minerTimerState.durationHours);
updateConverter("usd");
updateMinerSimulation();
updateMinerClock();

fetchBitcoinPrice();
tickerTimer = window.setInterval(() => {
    renderUpdatedTime();
    if (Date.now() - lastFetchAttemptAt >= priceRetryDelay) fetchBitcoinPrice();
}, 1000);
minerTimerInterval = window.setInterval(() => {
    if (minerTimerState?.status === "running") updateMinerClock();
}, 1000);

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateMinerClock();
    else persistMinerTimer();
});

window.addEventListener("pagehide", () => {
    persistMinerTimer();
});
window.addEventListener("pageshow", () => {
    window.clearInterval(tickerTimer);
    window.clearInterval(minerTimerInterval);
    tickerTimer = window.setInterval(() => {
        renderUpdatedTime();
        if (Date.now() - lastFetchAttemptAt >= priceRetryDelay) fetchBitcoinPrice();
    }, 1000);
    minerTimerInterval = window.setInterval(() => {
        if (minerTimerState?.status === "running") updateMinerClock();
    }, 1000);
    updateMinerClock();
});

